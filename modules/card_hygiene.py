import os
import time
import traceback
import json
import threading
import uuid
import random
import datetime
from typing import List, Dict, Any, Optional
from urllib.parse import urljoin

import requests
import urllib3
from sqlalchemy import text
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC

from core.database import engine
from modules.contact_fallbacks import delivery_fallback_query

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

VTADMIN_URL_LOGIN = os.getenv('VTADMIN_URL_LOGIN', 'https://vtadmin.manaus.prodatamobility.com.br')
VTADMIN_USERNAME = os.getenv('VTADMIN_USERNAME', '')
VTADMIN_PASSWORD = os.getenv('VTADMIN_PASSWORD', '')
VTADMIN_HOTLIST_REASON_VALUE = '10'
VTADMIN_LOGIN_PAGE_TIMEOUT = int(os.getenv('VTADMIN_LOGIN_PAGE_TIMEOUT', '30'))
VTADMIN_LOGIN_COMPLETE_TIMEOUT = int(os.getenv('VTADMIN_LOGIN_COMPLETE_TIMEOUT', '30'))
CARD_HYGIENE_MAX_BATCH = 10000
CARD_HYGIENE_DAILY_QUOTA = 5000
CARD_HYGIENE_DEFAULT_BIRTHDATE = os.getenv('CARD_HYGIENE_DEFAULT_BIRTHDATE', '01/01/1990')
CARD_HYGIENE_STALE_JOB_HOURS = int(os.getenv('CARD_HYGIENE_STALE_JOB_HOURS', '24'))

CARD_HYGIENE_ACTIVE_STATUSES = ('queued', 'running', 'cancel_requested')
CARD_HYGIENE_FINISHED_STATUSES = ('success', 'partial', 'failed', 'cancelled')


class CardHygieneCancelled(Exception):
    pass


class CardHygieneSkipped(Exception):
    def __init__(self, reason: str, status_text: str = ''):
        super().__init__(reason)
        self.reason = reason
        self.status_text = status_text


def card_hygiene_log(message: str):
    print(f"[CARD_HYGIENE] {message}")


def format_card_hygiene_exception(step: str, exc: Exception) -> str:
    exc_name = exc.__class__.__name__
    exc_text = str(exc).strip()
    if exc_text:
        return f"[{step}] {exc_name}: {exc_text}"
    return f"[{step}] {exc_name}"


# ---------------------------------------------------------------------------
# DB-backed job management
# ---------------------------------------------------------------------------

def ensure_card_hygiene_tables(conn):
    conn.execute(text("CREATE DATABASE IF NOT EXISTS databridge_web DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS databridge_web.databridge_card_hygiene_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            username VARCHAR(100) NOT NULL,
            vtadmin_username VARCHAR(100) NULL,
            observation TEXT NULL,
            filter_json LONGTEXT NULL,
            clients_json LONGTEXT NOT NULL,
            total_success INT NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_databridge_card_hygiene_logs_user
                FOREIGN KEY (user_id) REFERENCES databridge_web.databridge_users(id) ON DELETE CASCADE
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS databridge_web.databridge_card_hygiene_hidden_cards (
            card_number VARCHAR(100) NOT NULL PRIMARY KEY,
            cpf VARCHAR(20) NULL,
            nome VARCHAR(255) NULL,
            hidden_by_user_id INT NOT NULL,
            hidden_by_username VARCHAR(100) NOT NULL,
            source_log_id INT NULL,
            observation TEXT NULL,
            is_active TINYINT(1) DEFAULT 1,
            hidden_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reactivated_at DATETIME NULL,
            last_checked_at DATETIME NULL,
            last_known_hotlist_action VARCHAR(20) NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_databridge_card_hygiene_hidden_cards_user
                FOREIGN KEY (hidden_by_user_id) REFERENCES databridge_web.databridge_users(id) ON DELETE CASCADE,
            CONSTRAINT fk_databridge_card_hygiene_hidden_cards_log
                FOREIGN KEY (source_log_id) REFERENCES databridge_web.databridge_card_hygiene_logs(id) ON DELETE SET NULL
        )
    """))
    # Jobs table — stores background job state in DB (survives browser close / logout)
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS databridge_web.databridge_card_hygiene_jobs (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            user_id INT NOT NULL,
            username VARCHAR(100) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'queued',
            observation TEXT NULL,
            filter_json LONGTEXT NULL,
            selected_cards_json LONGTEXT NULL,
            cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
            progress_percent INT NOT NULL DEFAULT 0,
            progress_label VARCHAR(255) NULL,
            progress_detail TEXT NULL,
            current_card VARCHAR(100) NULL,
            current_cpf VARCHAR(20) NULL,
            processed INT NOT NULL DEFAULT 0,
            total INT NOT NULL DEFAULT 0,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            finished_at DATETIME NULL,
            popup_should_show TINYINT(1) NOT NULL DEFAULT 0,
            popup_closed_at DATETIME NULL,
            result_json LONGTEXT NULL,
            CONSTRAINT fk_databridge_card_hygiene_jobs_user
                FOREIGN KEY (user_id) REFERENCES databridge_web.databridge_users(id) ON DELETE CASCADE
        )
    """))
    for alter_sql in (
        "ALTER TABLE databridge_web.databridge_card_hygiene_logs ADD COLUMN vtadmin_username VARCHAR(100) NULL AFTER username",
        "ALTER TABLE databridge_web.databridge_card_hygiene_logs ADD COLUMN filter_json LONGTEXT NULL AFTER observation",
        "ALTER TABLE databridge_web.databridge_card_hygiene_jobs ADD COLUMN filter_json LONGTEXT NULL AFTER observation",
        "ALTER TABLE databridge_web.databridge_card_hygiene_jobs ADD COLUMN last_heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP AFTER started_at",
        "ALTER TABLE databridge_web.databridge_card_hygiene_jobs ADD COLUMN popup_should_show TINYINT(1) NOT NULL DEFAULT 0 AFTER finished_at",
        "ALTER TABLE databridge_web.databridge_card_hygiene_jobs ADD COLUMN popup_closed_at DATETIME NULL AFTER popup_should_show",
        "ALTER TABLE databridge_web.databridge_card_hygiene_hidden_cards ADD COLUMN reactivated_at DATETIME NULL",
        "ALTER TABLE databridge_web.databridge_card_hygiene_hidden_cards ADD COLUMN last_checked_at DATETIME NULL",
        "ALTER TABLE databridge_web.databridge_card_hygiene_hidden_cards ADD COLUMN last_known_hotlist_action VARCHAR(20) NULL",
    ):
        try:
            conn.execute(text(alter_sql))
        except Exception:
            pass


def create_hygiene_job(user_id: int, username: str, observation: str,
                       selected_cards: List[str], total: int,
                       filters: Optional[Dict[str, Any]] = None) -> str:
    """Insert a new job row and return its ID."""
    job_id = f"rhj_{uuid.uuid4().hex}"
    with engine.connect() as conn:
        ensure_card_hygiene_tables(conn)
        conn.execute(text("""
            INSERT INTO databridge_web.databridge_card_hygiene_jobs
                (id, user_id, username, status, observation, filter_json, selected_cards_json,
                 cancel_requested, progress_percent, progress_label, progress_detail,
                 processed, total, started_at, last_heartbeat_at, popup_should_show)
            VALUES
                (:id, :user_id, :username, 'queued', :observation, :filter_json, :cards_json,
                 0, 0, 'Na fila...', 'O processo será iniciado em breve.',
                 0, :total, NOW(), NOW(), 1)
        """), {
            'id': job_id,
            'user_id': user_id,
            'username': username,
            'observation': observation,
            'filter_json': json.dumps(filters or {}, ensure_ascii=False),
            'cards_json': json.dumps(selected_cards, ensure_ascii=False),
            'total': total,
        })
        conn.commit()
    return job_id


def update_job_progress(job_id: str, **fields):
    """Update job progress fields in DB. Safe to call from background thread."""
    allowed = {
        'status', 'progress_percent', 'progress_label', 'progress_detail',
        'current_card', 'current_cpf', 'processed', 'total',
    }
    sets = []
    params = {'jid': job_id}
    for k, v in fields.items():
        if k in allowed and v is not None:
            sets.append(f"{k} = :{k}")
            params[k] = v
    if not sets:
        return
    try:
        with engine.connect() as conn:
            conn.execute(text(
                f"UPDATE databridge_web.databridge_card_hygiene_jobs SET {', '.join(sets)}, last_heartbeat_at = NOW() WHERE id = :jid"
            ), params)
            conn.commit()
    except Exception as exc:
        card_hygiene_log(f"[update_job_progress] Erro ao atualizar DB para job {job_id}: {exc}")


def finish_job(job_id: str, status: str, result: Dict[str, Any]):
    try:
        with engine.connect() as conn:
            conn.execute(text("""
                UPDATE databridge_web.databridge_card_hygiene_jobs
                SET status = :status,
                    finished_at = NOW(),
                    result_json = :result_json,
                    progress_percent = 100
                WHERE id = :jid
            """), {
                'status': status,
                'result_json': json.dumps(result, ensure_ascii=False),
                'jid': job_id,
            })
            conn.commit()
    except Exception as exc:
        card_hygiene_log(f"[finish_job] Erro ao finalizar job {job_id}: {exc}")


def is_job_cancelled_in_db(job_id: str) -> bool:
    """Check whether cancel was requested via DB (works even after HTTP request ended)."""
    try:
        with engine.connect() as conn:
            row = conn.execute(text(
                "SELECT cancel_requested FROM databridge_web.databridge_card_hygiene_jobs WHERE id = :jid"
            ), {'jid': job_id}).fetchone()
            return bool(row and row[0])
    except Exception:
        return False


def get_job_from_db(job_id: str) -> Optional[Dict[str, Any]]:
    try:
        with engine.connect() as conn:
            mark_stale_hygiene_jobs(conn)
            row = conn.execute(text("""
                SELECT id, user_id, username, observation, status, progress_percent, progress_label,
                       progress_detail, current_card, current_cpf, processed, total,
                       started_at, finished_at, result_json, cancel_requested
                FROM databridge_web.databridge_card_hygiene_jobs
                WHERE id = :jid
            """), {'jid': job_id}).mappings().fetchone()
            if not row:
                return None
            d = dict(row)
            for k in ('started_at', 'finished_at'):
                if d.get(k) is not None and not isinstance(d[k], str):
                    d[k] = str(d[k])
            return d
    except Exception:
        return None


def mark_stale_hygiene_jobs(conn):
    """Close DB jobs whose in-process worker can no longer be alive."""
    try:
        stale_hours = max(1, int(CARD_HYGIENE_STALE_JOB_HOURS))
        conn.execute(text("""
            UPDATE databridge_web.databridge_card_hygiene_jobs
            SET status = CASE
                    WHEN cancel_requested = 1 THEN 'cancelled'
                    ELSE 'failed'
                END,
                finished_at = NOW(),
                progress_label = CASE
                    WHEN cancel_requested = 1 THEN 'Higienização cancelada'
                    ELSE 'Processo interrompido'
                END,
                progress_detail = CASE
                    WHEN cancel_requested = 1 THEN 'Cancelamento consolidado após expiração do processo em segundo plano.'
                    ELSE 'O processo ficou sem atualização por muito tempo e foi encerrado automaticamente. Verifique o VTAdmin antes de reprocessar os cartões restantes.'
                END,
                result_json = JSON_OBJECT(
                    'error', 'Job expirado automaticamente por ausência de worker ativo.',
                    'stale_job', true,
                    'stale_after_hours', :stale_hours
                )
            WHERE status IN ('queued', 'running', 'cancel_requested')
              AND finished_at IS NULL
              AND COALESCE(last_heartbeat_at, started_at) < DATE_SUB(NOW(), INTERVAL :stale_hours HOUR)
        """), {'stale_hours': stale_hours})
        conn.commit()
    except Exception as exc:
        card_hygiene_log(f"[mark_stale_hygiene_jobs] Erro ao expirar jobs antigos: {exc}")


def get_active_jobs_for_user(user_id: int) -> List[Dict[str, Any]]:
    try:
        with engine.connect() as conn:
            ensure_card_hygiene_tables(conn)
            mark_stale_hygiene_jobs(conn)
            rows = conn.execute(text("""
                SELECT id, user_id, username, status, progress_percent, progress_label,
                       progress_detail, current_card, current_cpf, processed, total,
                       started_at, finished_at, cancel_requested,
                       CASE
                         WHEN status IN ('queued', 'running', 'cancel_requested')
                              AND popup_closed_at IS NULL THEN 1
                         ELSE popup_should_show
                       END AS popup_should_show,
                       popup_closed_at
                FROM databridge_web.databridge_card_hygiene_jobs
                WHERE user_id = :uid
                  AND (
                    status IN ('queued', 'running', 'cancel_requested')
                    OR popup_should_show = 1
                  )
                ORDER BY started_at DESC
                LIMIT 10
            """), {'uid': user_id}).mappings().fetchall()
            result = []
            for row in rows:
                d = dict(row)
                for k in ('started_at', 'finished_at', 'popup_closed_at'):
                    if d.get(k) is not None and not isinstance(d[k], str):
                        d[k] = str(d[k])
                result.append(d)
            return result
    except Exception:
        return []


def set_hygiene_job_popup_closed(job_id: str, user_id: int, can_monitor: bool = False) -> bool:
    """Persist that the current user intentionally closed the hygiene popup."""
    try:
        with engine.connect() as conn:
            ensure_card_hygiene_tables(conn)
            owner_filter = "" if can_monitor else "AND user_id = :uid"
            result = conn.execute(text(f"""
                UPDATE databridge_web.databridge_card_hygiene_jobs
                SET popup_should_show = 0,
                    popup_closed_at = NOW()
                WHERE id = :jid {owner_filter}
            """), {'jid': job_id, 'uid': user_id})
            conn.commit()
            return result.rowcount > 0
    except Exception as exc:
        card_hygiene_log(f"[set_hygiene_job_popup_closed] Erro ao fechar popup do job {job_id}: {exc}")
        return False


def get_all_active_jobs() -> List[Dict[str, Any]]:
    """Return only actively running jobs (for admin monitoring)."""
    try:
        with engine.connect() as conn:
            mark_stale_hygiene_jobs(conn)
            rows = conn.execute(text("""
                SELECT id, user_id, username, status, progress_percent, progress_label,
                       progress_detail, current_card, current_cpf, processed, total,
                       started_at, finished_at, cancel_requested
                FROM databridge_web.databridge_card_hygiene_jobs
                WHERE status = 'running'
                ORDER BY started_at DESC
            """)).mappings().fetchall()
            result = []
            for row in rows:
                d = dict(row)
                for k in ('started_at', 'finished_at'):
                    if d.get(k) is not None and not isinstance(d[k], str):
                        d[k] = str(d[k])
                result.append(d)
            return result
    except Exception:
        return []


def get_user_daily_hygiene_usage(conn, user_id: int) -> int:
    """Return how many cards the user actually processed today."""
    try:
        row = conn.execute(text("""
            SELECT COALESCE(SUM(processed), 0)
            FROM databridge_web.databridge_card_hygiene_jobs
            WHERE user_id = :user_id 
              AND DATE(started_at) = CURDATE()
        """), {'user_id': user_id}).scalar()
        return int(row or 0)
    except Exception:
        return 0


def request_cancel_job(job_id: str) -> bool:
    """Write cancel_requested=1 to DB. The background thread will pick it up."""
    try:
        with engine.connect() as conn:
            conn.execute(text("""
                UPDATE databridge_web.databridge_card_hygiene_jobs
                SET cancel_requested = 1,
                    status = 'cancel_requested'
                WHERE id = :jid AND status IN ('queued', 'running', 'cancel_requested')
            """), {'jid': job_id})
            conn.commit()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Legacy in-memory shims (kept for compatibility during transition)
# ---------------------------------------------------------------------------
_card_hygiene_cancel_lock = threading.Lock()
_card_hygiene_cancel_flags: Dict[str, bool] = {}
_card_hygiene_progress_lock = threading.Lock()
_card_hygiene_progress: Dict[str, Dict[str, Any]] = {}


def cancel_card_hygiene_task(cancel_token: Optional[str]) -> bool:
    """Legacy cancel — now also writes to DB if token looks like a job_id."""
    if not cancel_token:
        return False
    if cancel_token.startswith('rhj_'):
        return request_cancel_job(cancel_token)
    with _card_hygiene_cancel_lock:
        _card_hygiene_cancel_flags[cancel_token] = True
    return True


def get_card_hygiene_progress(cancel_token: Optional[str]) -> Optional[Dict[str, Any]]:
    """Legacy progress getter — now reads from DB if token is a job_id."""
    if not cancel_token:
        return None
    if cancel_token.startswith('rhj_'):
        job = get_job_from_db(cancel_token)
        if not job:
            return None
        return {
            'ok': True,
            'found': True,
            'percent': job.get('progress_percent', 0),
            'label': job.get('progress_label', ''),
            'detail': job.get('progress_detail', ''),
            'current_card': job.get('current_card'),
            'current_cpf': job.get('current_cpf'),
            'processed': job.get('processed', 0),
            'total': job.get('total', 0),
            'status': job.get('status', 'unknown'),
        }
    with _card_hygiene_progress_lock:
        state = _card_hygiene_progress.get(cancel_token)
        if not state:
            return None
        return dict(state)


# ---------------------------------------------------------------------------
# VTAdmin automation helpers (unchanged from original)
# ---------------------------------------------------------------------------

def get_card_hygiene_exclusion_sql(alias='f'):
    return (
        f"NOT EXISTS ("
        f"SELECT 1 FROM databridge_web.databridge_card_hygiene_hidden_cards hc "
        f"WHERE CONVERT(hc.card_number USING utf8mb4) COLLATE utf8mb4_0900_ai_ci = "
        f"      CONVERT({alias}.cartao USING utf8mb4) COLLATE utf8mb4_0900_ai_ci "
        f"  AND hc.is_active = 1 "
        f"  AND COALESCE({alias}.ultimo_uso, {alias}.ultima_recarga, {alias}.recarga_pendente, '1900-01-01 00:00:00') <= hc.hidden_at"
        f")"
    )


def persist_card_hygiene_log(conn, user_id: int, username: str, vtadmin_username: str,
                              observation: str, success_items: List[Dict[str, Any]],
                              filters: Optional[Dict[str, Any]] = None):
    ensure_card_hygiene_tables(conn)
    conn.execute(text("""
        INSERT INTO databridge_web.databridge_card_hygiene_logs
            (user_id, username, vtadmin_username, observation, filter_json, clients_json, total_success)
        VALUES
            (:user_id, :username, :vtadmin_username, :observation, :filter_json, :clients_json, :total_success)
    """), {
        'user_id': user_id,
        'username': username,
        'vtadmin_username': (vtadmin_username or '').strip() or None,
        'observation': observation,
        'filter_json': json.dumps(filters or {}, ensure_ascii=False),
        'clients_json': json.dumps(success_items, ensure_ascii=False),
        'total_success': len(success_items),
    })
    log_id = conn.execute(text("SELECT LAST_INSERT_ID()")).scalar()

    for item in success_items:
        item_note = (item.get('note') or '').strip()
        combined_observation = '\n'.join(
            part for part in [observation, item_note] if (part or '').strip()
        ).strip()
        conn.execute(text("""
            INSERT INTO databridge_web.databridge_card_hygiene_hidden_cards
                (card_number, cpf, nome, hidden_by_user_id, hidden_by_username, source_log_id, observation, is_active)
            VALUES
                (:card_number, :cpf, :nome, :user_id, :username, :source_log_id, :observation, 1)
            ON DUPLICATE KEY UPDATE
                cpf = VALUES(cpf),
                nome = VALUES(nome),
                hidden_by_user_id = VALUES(hidden_by_user_id),
                hidden_by_username = VALUES(hidden_by_username),
                source_log_id = VALUES(source_log_id),
                observation = VALUES(observation),
                is_active = 1,
                reactivated_at = NULL,
                last_checked_at = NULL,
                last_known_hotlist_action = NULL,
                updated_at = CURRENT_TIMESTAMP
        """), {
            'card_number': str(item.get('cartao') or '').strip(),
            'cpf': str(item.get('cpf') or '').strip(),
            'nome': (item.get('nome') or '').strip(),
            'user_id': user_id,
            'username': username,
            'source_log_id': log_id,
            'observation': combined_observation,
        })

    return log_id


def detect_vtadmin_unavailable(driver):
    try:
        current_url = (driver.current_url or '').lower()
    except Exception:
        current_url = ''
    try:
        title = (driver.title or '').lower()
    except Exception:
        title = ''
    try:
        page_source = (driver.page_source or '').lower()
    except Exception:
        page_source = ''

    unavailable_markers = [
        'http error 404',
        'the requested resource is not found',
        '<h1>not found</h1>',
        '404',
    ]
    if any(marker in page_source for marker in unavailable_markers) or 'wfm_default.aspx' in current_url and 'not found' in page_source:
        raise RuntimeError('VTAdmin fora do ar no momento: a página retornou erro 404 (Not Found).')
    if 'not found' in title and 'vtadmin' in current_url:
        raise RuntimeError('VTAdmin fora do ar no momento: a página inicial retornou Not Found.')


def create_vtadmin_driver():
    options = webdriver.ChromeOptions()
    options.page_load_strategy = 'eager'
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--log-level=3")
    options.add_experimental_option("excludeSwitches", ["enable-logging"])
    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(30)
    return driver


def vtadmin_switch_main_iframe(driver):
    driver.switch_to.default_content()
    frame_locators = [
        (By.ID, "FRAME"),
        (By.NAME, "FRAME"),
        (By.TAG_NAME, "iframe"),
    ]
    last_error = None
    for locator in frame_locators:
        try:
            WebDriverWait(driver, 20).until(
                EC.frame_to_be_available_and_switch_to_it(locator)
            )
            return
        except Exception as exc:
            last_error = exc
            driver.switch_to.default_content()
    raise last_error


def vtadmin_is_logged_in(driver) -> bool:
    success_locators = [
        (By.XPATH, "//li[@id='parent_uca']/a"),
        (By.XPATH, "//li/a[contains(text(),'Lista')]"),
        (By.ID, "txtCode"),
        (By.ID, "txtDoc"),
    ]
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    for locator in success_locators:
        try:
            elems = driver.find_elements(*locator)
            if any(el.is_displayed() for el in elems):
                return True
        except Exception:
            pass

    try:
        vtadmin_switch_main_iframe(driver)
        for locator in ((By.ID, "txtCode"), (By.ID, "txtDoc"), (By.ID, "gvCards"), (By.ID, "dgUser")):
            try:
                elems = driver.find_elements(*locator)
                if any(el.is_displayed() for el in elems):
                    return True
            except Exception:
                pass
    except Exception:
        pass
    finally:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass

    return False


def vtadmin_can_open_uca(driver) -> bool:
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    try:
        uca_link = WebDriverWait(driver, 3).until(
            EC.element_to_be_clickable((By.XPATH, "//li[@id='parent_uca']/a"))
        )
        driver.execute_script("arguments[0].click();", uca_link)
        return True
    except Exception:
        return False


def vtadmin_capture_login_state(driver) -> str:
    try:
        title = (driver.title or '').strip()
    except Exception:
        title = ''
    try:
        current_url = (driver.current_url or '').strip()
    except Exception:
        current_url = ''

    visible_ids = []
    for element_id in ('txtLogin', 'txtSenha', 'loginbutton', 'parent_uca', 'txtCode', 'txtDoc'):
        try:
            if any(el.is_displayed() for el in driver.find_elements(By.ID, element_id)):
                visible_ids.append(element_id)
        except Exception:
            pass

    iframe_count = 0
    try:
        iframe_count = len(driver.find_elements(By.TAG_NAME, 'iframe'))
    except Exception:
        pass

    return f"title='{title}' url='{current_url}' visible_ids={visible_ids} iframes={iframe_count}"


def validate_vtadmin_credentials(vtadmin_username: str, vtadmin_password: str) -> tuple[bool, str]:
    username = (vtadmin_username or '').strip()
    password = vtadmin_password if vtadmin_password is not None else ''
    if not username:
        return False, 'Informe o usuario do VTAdmin.'
    if not str(password).strip():
        return False, 'Informe a senha do VTAdmin.'

    try:
        session = requests.Session()
        session.verify = False
        session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
        })

        def qc_cript(txt: str) -> str:
            ret = []
            for ch in txt:
                for _ in range(5):
                    chr_code = 65 + random.randrange(50)
                    if 90 < chr_code < 97:
                        chr_code = 76
                    ret.append(chr(chr_code))
                ret.append(ch)
            return ''.join(ret)

        login_page = session.get(VTADMIN_URL_LOGIN, timeout=(3, 5))
        if login_page.status_code >= 500:
            return False, 'VTAdmin indisponível no momento.'

        async_url = urljoin(VTADMIN_URL_LOGIN.rstrip('/') + '/', 'Login_Async.aspx')
        response = session.get(
            async_url,
            params={
                'usr': qc_cript(username),
                'pass': qc_cript(password),
            },
            timeout=(3, 5),
        )
        payload = (response.text or '').lower()

        if 'ok:sessionactive' in payload:
            return True, 'Credenciais validadas com sucesso.'
        if 'wrong:' in payload:
            return False, 'Login ou senha do VTAdmin incorretos.'

        default_page = session.get(urljoin(VTADMIN_URL_LOGIN.rstrip('/') + '/', 'wfm_default.aspx'), timeout=(3, 5))
        default_payload = (default_page.text or '').lower()
        if 'parent_uca' in default_payload or 'wfm_default.aspx' in (default_page.url or '').lower():
            return True, 'Credenciais validadas com sucesso.'
        if 'txtlogin' in default_payload and 'txtsenha' in default_payload:
            return False, 'Login ou senha do VTAdmin incorretos.'
        return False, 'Nao foi possivel validar o acesso ao VTAdmin agora. Tente novamente.'
    except Exception as exc:
        message = str(exc).strip()
        if 'VTAdmin fora do ar' in message:
            return False, message
        return False, f'Falha ao validar credenciais no VTAdmin: {message or exc.__class__.__name__}'


def normalize_phone_parts(raw_phone: Any) -> Optional[Dict[str, str]]:
    digits = ''.join(ch for ch in str(raw_phone or '') if ch.isdigit())
    if not digits:
        return None

    if digits.startswith('55') and len(digits) >= 12:
        digits = digits[2:]

    if len(digits) in (8, 9):
        digits = f'92{digits}'
    elif len(digits) < 10:
        return None

    if len(digits) > 11:
        digits = digits[-11:]

    ddd = digits[:2]
    phone = digits[2:]
    if len(phone) not in (8, 9):
        return None
    if set(phone) == {'0'}:
        return None

    return {
        'ddd': ddd,
        'phone': phone,
        'full': f'{ddd}{phone}',
    }


def lookup_phone_for_hygiene(cpf: str) -> Optional[Dict[str, str]]:
    cpf_digits = ''.join(ch for ch in str(cpf or '') if ch.isdigit())
    if not cpf_digits:
        return None

    cliente_delivery_sql = delivery_fallback_query(f"u.cpf = '{cpf_digits}'").text

    queries = [
        (
            'CLIENTE',
            text(f"""
                SELECT COALESCE(dl.celular_entrega, c.cellphone) AS phone
                FROM sntr_cliente.customer c
                LEFT JOIN (
                    {cliente_delivery_sql}
                ) dl ON dl.cpf_limpo = REPLACE(REPLACE(c.cpf, '.', ''), '-', '')
                WHERE REPLACE(REPLACE(c.cpf, '.', ''), '-', '') = :cpf
                LIMIT 1
            """),
        ),
        (
            'ESTUDANTE',
            text("""
                SELECT celular AS phone
                FROM databridge_db.alunos
                WHERE cpf = :cpf
                  AND celular IS NOT NULL
                  AND TRIM(celular) <> ''
                LIMIT 1
            """),
        ),
        (
            'ABT',
            text("""
                SELECT celular AS phone
                FROM sntr_interligar.COM_CLIENTES_ABT
                WHERE REPLACE(REPLACE(documento, '.', ''), '-', '') = :cpf
                  AND celular IS NOT NULL
                  AND TRIM(celular) <> ''
                ORDER BY data_cadastro DESC
                LIMIT 1
            """),
        ),
        (
            'WIFI',
            text("""
                SELECT MAX(TELEFONE) AS phone
                FROM sntr_interligar.WIFIMAX_USERS
                WHERE CPF = :cpf
                GROUP BY CPF
            """),
        ),
        (
            'WHATSAPP',
            text("""
                SELECT telefone AS phone
                FROM sntr_interligar.CLIENTES_WHATSAPP
                WHERE cpf = :cpf
                  AND telefone IS NOT NULL
                  AND TRIM(telefone) <> ''
                LIMIT 1
            """),
        ),
        (
            'MERCURY',
            text("""
                SELECT telefone AS phone
                FROM sntr_interligar.SALES_CAD_UNICO_JSON
                WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = :cpf
                  AND telefone IS NOT NULL
                  AND TRIM(telefone) <> ''
                LIMIT 1
            """),
        ),
    ]

    with engine.connect() as conn:
        for source, sql in queries:
            try:
                raw_phone = conn.execute(sql, {'cpf': cpf_digits}).scalar()
            except Exception as exc:
                card_hygiene_log(f"Falha ao consultar telefone na base {source} para CPF {cpf_digits}: {exc}")
                continue

            parts = normalize_phone_parts(raw_phone)
            if parts:
                parts['source'] = source
                return parts

    return None


def normalize_birthdate_for_vtadmin(raw_value: Any) -> Optional[str]:
    if raw_value is None:
        return None

    raw_text = str(raw_value).strip()
    if not raw_text or raw_text.lower() in {'none', 'null', 'nat'}:
        return None

    raw_text = raw_text.split(' ')[0].split('T')[0].strip()
    formats = ('%Y-%m-%d', '%d/%m/%Y', '%Y/%m/%d', '%d-%m-%Y')
    parsed = None
    for fmt in formats:
        try:
            parsed = datetime.datetime.strptime(raw_text, fmt)
            break
        except Exception:
            continue

    if parsed is None:
        digits = ''.join(ch for ch in raw_text if ch.isdigit())
        if len(digits) == 8:
            try:
                if raw_text.count('/') == 2 or raw_text.count('-') == 2:
                    parsed = datetime.datetime.strptime(raw_text.replace('-', '/'), '%d/%m/%Y')
                else:
                    parsed = datetime.datetime.strptime(digits, '%Y%m%d')
            except Exception:
                parsed = None

    if parsed is None:
        return None

    if parsed.year < 1900 or parsed.date() > datetime.date.today():
        return None

    return parsed.strftime('%d/%m/%Y')


def lookup_birthdate_for_hygiene(cpf: str) -> Optional[Dict[str, str]]:
    cpf_digits = ''.join(ch for ch in str(cpf or '') if ch.isdigit())
    if not cpf_digits:
        return None

    queries = [
        (
            'CLIENTE',
            text("""
                SELECT birth_date AS birthdate
                FROM sntr_cliente.customer
                WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = :cpf
                  AND birth_date IS NOT NULL
                LIMIT 1
            """),
        ),
        (
            'ESTUDANTE',
            text("""
                SELECT data_nascimento AS birthdate
                FROM databridge_db.alunos
                WHERE cpf = :cpf
                  AND data_nascimento IS NOT NULL
                LIMIT 1
            """),
        ),
        (
            'ABT',
            text("""
                SELECT nascimento AS birthdate
                FROM sntr_interligar.COM_CLIENTES_ABT
                WHERE REPLACE(REPLACE(documento, '.', ''), '-', '') = :cpf
                  AND nascimento IS NOT NULL
                ORDER BY data_cadastro DESC
                LIMIT 1
            """),
        ),
        (
            'WIFI',
            text("""
                SELECT DATA_NASCIMENTO AS birthdate
                FROM sntr_interligar.WIFIMAX_USERS
                WHERE CPF = :cpf
                  AND DATA_NASCIMENTO IS NOT NULL
                LIMIT 1
            """),
        ),
    ]

    found_birthdates: Dict[str, List[str]] = {}

    with engine.connect() as conn:
        for source, sql in queries:
            try:
                raw_birthdate = conn.execute(sql, {'cpf': cpf_digits}).scalar()
            except Exception as exc:
                card_hygiene_log(f"Falha ao consultar data de nascimento na base {source} para CPF {cpf_digits}: {exc}")
                continue

            formatted_birthdate = normalize_birthdate_for_vtadmin(raw_birthdate)
            if formatted_birthdate:
                found_birthdates.setdefault(formatted_birthdate, []).append(source)

    if not found_birthdates:
        return {
            'birthdate': CARD_HYGIENE_DEFAULT_BIRTHDATE,
            'source': 'PADRAO',
            'consensus_count': 0,
            'sources_checked': 0,
            'note': f"Data de nascimento padrão aplicada: {CARD_HYGIENE_DEFAULT_BIRTHDATE} (nenhuma base retornou data).",
            'is_default': True,
        }

    total_found = sum(len(sources) for sources in found_birthdates.values())
    winner_birthdate = None
    winner_sources: List[str] = []
    for birthdate, sources in found_birthdates.items():
        if len(sources) > len(winner_sources):
            winner_birthdate = birthdate
            winner_sources = sources

    if not winner_birthdate or len(winner_sources) < 2 or len(winner_sources) <= total_found / 2:
        card_hygiene_log(
            f"Data de nascimento sem maioria para o CPF {cpf_digits}: "
            + ', '.join(f"{birthdate} ({'/'.join(sources)})" for birthdate, sources in found_birthdates.items())
        )
        return {
            'birthdate': CARD_HYGIENE_DEFAULT_BIRTHDATE,
            'source': 'PADRAO',
            'consensus_count': len(winner_sources),
            'sources_checked': total_found,
            'note': (
                f"Data de nascimento padrão aplicada: {CARD_HYGIENE_DEFAULT_BIRTHDATE} "
                f"(sem maioria entre as bases: "
                + ', '.join(f"{birthdate} ({'/'.join(sources)})" for birthdate, sources in found_birthdates.items())
                + ")."
            ),
            'is_default': True,
        }

    return {
        'birthdate': winner_birthdate,
        'source': '/'.join(winner_sources),
        'consensus_count': len(winner_sources),
        'sources_checked': total_found,
        'note': f"Data de nascimento preenchida por maioria: {winner_birthdate} ({'/'.join(winner_sources)}).",
        'is_default': False,
    }


def vtadmin_login(driver, job_id=None, vtadmin_username=None, vtadmin_password=None):
    login_username = (vtadmin_username or VTADMIN_USERNAME or '').strip()
    login_password = vtadmin_password if vtadmin_password is not None else VTADMIN_PASSWORD
    if not login_username or not login_password:
        raise RuntimeError('Credenciais do VTAdmin não informadas.')

    for attempt in range(3):
        try:
            card_hygiene_log(f"Iniciando login no VTAdmin (tentativa {attempt + 1}/3)")
            _check_cancelled(job_id, 'abrindo login vtadmin')
            driver.get(VTADMIN_URL_LOGIN)
            detect_vtadmin_unavailable(driver)
            
            end_time = time.time() + VTADMIN_LOGIN_PAGE_TIMEOUT
            txt_login = None
            while time.time() < end_time:
                _check_cancelled(job_id, 'aguardando tela de login')
                try:
                    txt_login = driver.find_element(By.ID, "txtLogin")
                    break
                except Exception:
                    time.sleep(0.5)
            
            if not txt_login:
                raise RuntimeError("Timeout esperando campo txtLogin")
            
            txt_login.send_keys(login_username)
            driver.find_element(By.ID, "txtSenha").send_keys(login_password)
            driver.find_element(By.ID, "loginbutton").click()
            detect_vtadmin_unavailable(driver)
            
            end_time = time.time() + VTADMIN_LOGIN_COMPLETE_TIMEOUT
            while time.time() < end_time:
                _check_cancelled(job_id, 'aguardando conclusão do login')
                detect_vtadmin_unavailable(driver)
                if vtadmin_is_logged_in(driver):
                    card_hygiene_log("Login no VTAdmin confirmado com sucesso")
                    return
                time.sleep(0.5)
                    
            raise RuntimeError(f"Timeout esperando conclusao do login. Estado final: {vtadmin_capture_login_state(driver)}")
        except Exception as exc:
            card_hygiene_log(f"Falha na tentativa de login {attempt + 1}/3: {exc}")
            if isinstance(exc, CardHygieneCancelled):
                raise
            if isinstance(exc, RuntimeError) and 'VTAdmin fora do ar' in str(exc):
                raise
            if attempt >= 2:
                raise
            time.sleep(3)



def vtadmin_click_menu(driver):
    driver.switch_to.default_content()
    card_hygiene_log('Acessando registro selecionado')
    WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((By.XPATH, "//li[@id='parent_uca']/a"))
    ).click()
    WebDriverWait(driver, 20).until(
        EC.element_to_be_clickable((By.XPATH, "//li/a[contains(text(),'Lista')]"))
    ).click()


def vtadmin_run_search(driver, search_value: str, search_field_id: str):
    vtadmin_switch_main_iframe(driver)
    field = WebDriverWait(driver, 20).until(
        EC.presence_of_element_located((By.ID, search_field_id))
    )
    field.clear()
    field.send_keys(search_value)
    driver.find_element(By.NAME, "btnEldery").click()


def vtadmin_find_card_link(driver, card_number: str, timeout_seconds: int = 12):
    card_locators = [
        (By.XPATH, f"//a[@id='gvCards__ctl3_lnkCard' and normalize-space()='{card_number}']"),
        (By.XPATH, f"//a[contains(@id,'lnkCard') and normalize-space()='{card_number}']"),
        (By.XPATH, f"//td[@nowrap='nowrap']//a[contains(@id,'lnkCard') and normalize-space()='{card_number}']"),
        (By.LINK_TEXT, card_number),
        (By.PARTIAL_LINK_TEXT, card_number),
    ]

    last_error = None
    for locator in card_locators:
        try:
            return WebDriverWait(driver, timeout_seconds).until(
                EC.element_to_be_clickable(locator)
            )
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"Nao foi possivel localizar o cartao {card_number} na grade Cartoes do Usuario.") from last_error


def vtadmin_get_card_row_info(driver, card_number: str, timeout_seconds: int = 10) -> Dict[str, Any]:
    vtadmin_switch_main_iframe(driver)
    row_locators = [
        (By.XPATH, f"//table[@id='gvCards']//tr[td[1]//a[normalize-space()='{card_number}']]"),
        (By.XPATH, f"//table[@id='gvCards']//tr[td[1][normalize-space()='{card_number}']]"),
        (By.XPATH, f"//tr[td[1]//a[normalize-space()='{card_number}']]"),
        (By.XPATH, f"//tr[td[1][normalize-space()='{card_number}']]"),
    ]

    last_error = None
    row = None
    for locator in row_locators:
        try:
            row = WebDriverWait(driver, timeout_seconds).until(
                EC.presence_of_element_located(locator)
            )
            break
        except Exception as exc:
            last_error = exc

    if row is None:
        raise RuntimeError(f"Nao foi possivel localizar a linha do cartao {card_number} na grade Cartoes do Usuario.") from last_error

    cells = row.find_elements(By.TAG_NAME, 'td')
    status_text = ''
    if len(cells) > 1:
        status_text = (cells[1].text or '').strip()

    return {
        'row': row,
        'cells': cells,
        'status': status_text,
    }


def vtadmin_try_open_card(driver, search_value: str, card_number: str, search_field_id: str = 'txtCode'):
    card_hygiene_log(
        f"Buscando cadastro no VTAdmin com chave '{search_value}' no campo '{search_field_id}' para o cartao {card_number}"
    )
    vtadmin_run_search(driver, search_value, search_field_id)

    parent_xpaths = [
        f"//a[normalize-space()='{search_value}' and not(contains(@id,'lnkCard'))]",
        f"//a[contains(@href,'__doPostBack') and normalize-space()='{search_value}' and not(contains(@id,'lnkCard'))]",
        "//a[contains(@href,'__doPostBack') and not(contains(@id,'lnkCard'))]",
    ]

    entered_parent = False
    last_error = None
    for parent_xpath in parent_xpaths:
        try:
            vtadmin_switch_main_iframe(driver)
            candidates = driver.find_elements(By.XPATH, parent_xpath)
        except Exception as exc:
            last_error = exc
            candidates = []

        if not candidates:
            continue

        for index in range(len(candidates)):
            try:
                vtadmin_run_search(driver, search_value, search_field_id)
                vtadmin_switch_main_iframe(driver)
                refreshed_candidates = driver.find_elements(By.XPATH, parent_xpath)
                if index >= len(refreshed_candidates):
                    continue

                parent_link = refreshed_candidates[index]
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", parent_link)
                driver.execute_script("arguments[0].click();", parent_link)
                entered_parent = True
                card_hygiene_log(
                    f"Resultado principal aberto com a chave '{search_value}' (candidato {index + 1} de {len(refreshed_candidates)})"
                )

                link = vtadmin_find_card_link(driver, card_number, timeout_seconds=4)
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", link)
                row_info = vtadmin_get_card_row_info(driver, card_number, timeout_seconds=4)
                status_text = (row_info.get('status') or '').strip()
                if status_text:
                    card_hygiene_log(f"Cartao {card_number} validado na grade Cartoes do Usuario com status '{status_text}'")
                else:
                    card_hygiene_log(f"Cartao {card_number} validado na grade Cartoes do Usuario")
                return row_info
            except Exception as exc:
                last_error = exc
                card_hygiene_log(
                    f"Candidato {index + 1} da chave '{search_value}' nao corresponde ao cartao {card_number}: {exc}"
                )

    if not entered_parent:
        card_hygiene_log(f"Nao consegui abrir o resultado principal com a chave '{search_value}'")

    try:
        parent_links = driver.find_elements(By.XPATH, "//a[contains(@href,'__doPostBack') and not(contains(@id,'lnkCard'))]")
        available_cards = driver.find_elements(By.XPATH, "//a[contains(@id,'lnkCard')]")
        available_text = [el.text.strip() for el in available_cards if el.text.strip()]
        parent_text = [el.text.strip() for el in parent_links if el.text.strip()]
    except Exception:
        available_text = []
        parent_text = []

    detail = f'Nao foi possivel localizar o cartao {card_number} no VTAdmin.'
    if not entered_parent and parent_text:
        detail += f" Resultado principal visivel: {', '.join(parent_text[:5])}"
    if available_text:
        detail += f" Cartoes visiveis: {', '.join(available_text[:5])}"
    raise RuntimeError(detail) from last_error


def vtadmin_open_card(driver, card_number: str, cpf: str = ''):
    vtadmin_click_menu(driver)
    search_candidates = []
    if cpf:
        cpf_digits = ''.join(ch for ch in str(cpf) if ch.isdigit())
        if cpf_digits:
            search_candidates.append((cpf_digits, 'txtDoc'))
            if len(cpf_digits) == 11:
                search_candidates.append((f"{cpf_digits[:3]}.{cpf_digits[3:6]}.{cpf_digits[6:9]}-{cpf_digits[9:]}", 'txtDoc'))
    search_candidates.append((card_number, 'txtCode'))

    last_error = None
    attempted = []
    for search_value, field_id in search_candidates:
        try:
            attempted.append(f"{search_value} [{field_id}]")
            return vtadmin_try_open_card(driver, search_value, card_number, field_id)
        except Exception as exc:
            last_error = exc
            card_hygiene_log(
                f"Falha ao abrir cartao {card_number} com chave '{search_value}' no campo '{field_id}': {exc}"
            )
    tried = ', '.join(attempted) if attempted else 'nenhuma chave'
    raise RuntimeError(
        f'Nao foi possivel localizar o cartao {card_number} no VTAdmin. '
        f'Chaves tentadas: {tried}. Ultimo erro: {last_error}'
    ) from last_error


def normalize_vtadmin_card_status(status_text: str) -> str:
    text_value = (status_text or '').strip().upper()
    return (
        text_value
        .replace('Ã', 'A')
        .replace('Á', 'A')
        .replace('À', 'A')
        .replace('Â', 'A')
        .replace('É', 'E')
        .replace('Ê', 'E')
        .replace('Í', 'I')
        .replace('Ó', 'O')
        .replace('Ô', 'O')
        .replace('Õ', 'O')
        .replace('Ú', 'U')
        .replace('Ç', 'C')
    )


def vtadmin_get_hotlist_action(driver, card_number: str) -> Optional[str]:
    vtadmin_switch_main_iframe(driver)
    action_locators = [
        (By.XPATH, f"//tr[td[normalize-space()='{card_number}']]//a[normalize-space()='Enviar']"),
        (By.XPATH, f"//tr[td[normalize-space()='{card_number}']]//a[normalize-space()='Retirar']"),
        (By.XPATH, f"//a[contains(@onclick,'CARDNUMBERTOHOTLIST={card_number}')]"),
    ]
    end_time = time.time() + 4
    while time.time() < end_time:
        for locator in action_locators:
            try:
                elems = driver.find_elements(*locator)
                for link in elems:
                    if link.is_displayed():
                        text_value = (link.text or '').strip()
                        if text_value in {'Enviar', 'Retirar'}:
                            return text_value
                        onclick = (link.get_attribute('onclick') or '').lower()
                        if 'wfm_card_hotlist.aspx' in onclick:
                            return 'Enviar'
            except Exception:
                pass
        time.sleep(0.2)
    return None


def vtadmin_find_hotlist_send_link_for_card(driver, card_number: str):
    vtadmin_switch_main_iframe(driver)
    row_xpath = (
        f"//table[@id='gvCards']//tr[td[1]//a[normalize-space()='{card_number}'] "
        f"or td[1][normalize-space()='{card_number}']]"
    )
    end_time = time.time() + 5
    last_error = None

    while time.time() < end_time:
        try:
            rows = driver.find_elements(By.XPATH, row_xpath)
            for row in rows:
                cells = row.find_elements(By.TAG_NAME, 'td')
                if not cells:
                    continue
                first_cell = ' '.join((cells[0].text or '').split())
                if card_number not in first_cell:
                    continue

                status_text = ' '.join((cells[1].text or '').split()) if len(cells) > 1 else ''
                links = row.find_elements(By.XPATH, ".//a[normalize-space()='Enviar']")
                for link in links:
                    if link.is_displayed() and link.is_enabled():
                        return link, status_text

                retirar_links = row.find_elements(By.XPATH, ".//a[normalize-space()='Retirar']")
                if retirar_links:
                    raise CardHygieneSkipped(
                        f"Cartao {card_number} ignorado porque ja esta em lista de restricao.",
                        status_text=status_text or 'Em Lista de Restricao',
                    )
                if status_text:
                    raise CardHygieneSkipped(
                        f"Cartao {card_number} ignorado porque nao possui acao Enviar na linha correta (status '{status_text}').",
                        status_text=status_text,
                    )
        except CardHygieneSkipped:
            raise
        except Exception as exc:
            last_error = exc
        time.sleep(0.2)

    raise RuntimeError(
        f"Link 'Enviar' nao encontrado na linha exata do cartao {card_number}. "
        "A higienizacao foi interrompida para evitar bloquear outro cartao."
    ) from last_error


def vtadmin_find_ok_and_click(driver):
    driver.switch_to.default_content()
    direct_ok_paths = [
        (By.XPATH, "//input[@value='OK']"),
        (By.XPATH, "//input[contains(@onclick,'GoToPage')]"),
    ]
    end_time = time.time() + 3
    clicked = False
    while time.time() < end_time and not clicked:
        for locator in direct_ok_paths:
            try:
                elems = driver.find_elements(*locator)
                for el in elems:
                    if el.is_displayed() and el.is_enabled():
                        el.click()
                        clicked = True
                        break
            except Exception:
                pass
            if clicked:
                break
        if not clicked:
            time.sleep(0.15)
    if clicked:
        return

    try:
        WebDriverWait(driver, 3).until(
            EC.frame_to_be_available_and_switch_to_it((By.XPATH, "//iframe[contains(@src,'ClientMessage')]"))
        )
        WebDriverWait(driver, 4).until(
            EC.element_to_be_clickable((By.XPATH, "//input[@value='OK']"))
        ).click()
    finally:
        driver.switch_to.default_content()


def _switch_to_phone_menu_frame(driver):
    frame_locators = [
        (By.ID, 'menuframe'),
        (By.NAME, 'menuframe'),
        (By.XPATH, '//*[@id="menuframe"]'),
    ]
    last_error = None
    for locator in frame_locators:
        try:
            WebDriverWait(driver, 12).until(
                EC.frame_to_be_available_and_switch_to_it(locator)
            )
            return
        except Exception as exc:
            last_error = exc
    raise last_error


def _open_phone_tab(driver):
    try:
        used_process_menu = driver.execute_script("""
            if (typeof ProcessMenu === 'function') {
                return ProcessMenu('wfm_Telephones_Ins.aspx','2','3');
            }
            return null;
        """)
        if used_process_menu is not None:
            return
    except Exception:
        pass

    tab_locators = [
        (By.XPATH, "/html/body/form/div/table/tbody/tr/td/fieldset/table/tbody/tr[20]/td/table/tbody/tr/td/span/table/tbody/tr[1]/td/table/tbody/tr/td[6]/a"),
        (By.XPATH, "//a[@onclick=\"return ProcessMenu('wfm_Telephones_Ins.aspx','2','3');\"]"),
        (By.XPATH, '//*[@id="tdmenu_2"]/a'),
        (By.ID, 'tdmenu_2'),
        (By.CSS_SELECTOR, '#tdmenu_2 a'),
        (By.XPATH, "//*[contains(@onclick,\"ProcessMenu('wfm_Telephones_Ins.aspx','2','3')\")]"),
        (By.XPATH, "//a[contains(., 'Telefone') or contains(., 'Telefones')]"),
    ]
    last_error = None
    for locator in tab_locators:
        try:
            elem = WebDriverWait(driver, 8).until(
                EC.presence_of_element_located(locator)
            )
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", elem)
            driver.execute_script("arguments[0].click();", elem)
            return
        except Exception as exc:
            last_error = exc
    raise last_error


def vtadmin_ensure_phone_for_observation(driver, cpf: str, job_id: Optional[str] = None) -> Dict[str, Any]:
    cpf_digits = ''.join(ch for ch in str(cpf or '') if ch.isdigit())
    card_hygiene_log(f"Verificando telefones antes de salvar a observacao do CPF {cpf_digits or 'sem_cpf'}")
    _check_cancelled(job_id, f'{cpf_digits or "cadastro"} / verificar telefone antes da observacao')
    stage = 'entrar_frame_principal_telefones'
    try:
        driver.switch_to.default_content()
        vtadmin_switch_main_iframe(driver)
        stage = 'localizar_e_clicar_aba_telefones'
        phone_tab = WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.XPATH, '//*[@id="tdmenu_2"]/a'))
        )
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", phone_tab)
        driver.execute_script("arguments[0].click();", phone_tab)

        stage = 'acessar_menuframe_telefones'
        driver.switch_to.default_content()
        vtadmin_switch_main_iframe(driver)
        WebDriverWait(driver, 10).until(
            EC.frame_to_be_available_and_switch_to_it((By.XPATH, '//*[@id="menuframe"]'))
        )

        stage = 'validar_tela_telefones'
        existing_phone_rows = driver.find_elements(
            By.XPATH,
            "//table[@id='dgTelephones']//tr[td[1][normalize-space()='CELULAR' or normalize-space()='COMERCIAL' or normalize-space()='FAX' or normalize-space()='RESIDENCIAL' or normalize-space()='SAC']]"
        )
        if not existing_phone_rows:
            existing_phone_rows = driver.find_elements(
                By.XPATH,
                "/html/body/form/table/tbody/tr[5]/td/table/tbody/tr[position()>1 and td[1][normalize-space()='CELULAR' or normalize-space()='COMERCIAL' or normalize-space()='FAX' or normalize-space()='RESIDENCIAL' or normalize-space()='SAC']]"
            )
        if existing_phone_rows:
            phone_type = ''
            try:
                phone_type = (existing_phone_rows[0].find_elements(By.TAG_NAME, 'td')[0].text or '').strip().upper()
            except Exception:
                phone_type = 'EXISTENTE'
            card_hygiene_log(f"Cadastro ja possui telefone {phone_type or 'EXISTENTE'} no VTAdmin; nenhuma insercao necessaria")
            return {'inserted': False, 'source': 'VTADMIN'}

        has_inputs = bool(driver.find_elements(By.ID, 'txtArea')) and bool(driver.find_elements(By.ID, 'txtPhone')) and bool(driver.find_elements(By.ID, 'btnInsert'))
        if not has_inputs:
            raise RuntimeError('Tela de telefones nao carregou os campos esperados no menuframe.')

        stage = 'buscar_telefone_fallback'
        fallback_phone = lookup_phone_for_hygiene(cpf_digits)
        if fallback_phone:
            ddd = fallback_phone['ddd']
            phone = fallback_phone['phone']
            source = fallback_phone.get('source') or 'BASE_EXTERNA'
            card_hygiene_log(f"Telefone encontrado na base {source}: DDD {ddd} com {len(phone)} digitos")
        else:
            ddd = '92'
            phone = '999999999'
            source = 'NEUTRO'
            card_hygiene_log("Nenhum telefone valido encontrado nas bases auxiliares; inserindo telefone neutro")

        stage = 'preencher_telefone'
        txt_area = None
        txt_phone = None
        btn_insert = None

        txt_area_locators = [
            (By.ID, 'txtArea'),
            (By.XPATH, '/html/body/form/table/tbody/tr[1]/td/input[1]'),
        ]
        txt_phone_locators = [
            (By.ID, 'txtPhone'),
            (By.XPATH, '/html/body/form/table/tbody/tr[1]/td/input[2]'),
        ]
        btn_insert_locators = [
            (By.ID, 'btnInsert'),
            (By.XPATH, '/html/body/form/table/tbody/tr[3]/td/input'),
        ]

        for locator in txt_area_locators:
            try:
                txt_area = WebDriverWait(driver, 4).until(EC.presence_of_element_located(locator))
                break
            except Exception:
                pass
        for locator in txt_phone_locators:
            try:
                txt_phone = WebDriverWait(driver, 4).until(EC.presence_of_element_located(locator))
                break
            except Exception:
                pass
        for locator in btn_insert_locators:
            try:
                btn_insert = WebDriverWait(driver, 4).until(EC.presence_of_element_located(locator))
                break
            except Exception:
                pass

        if not txt_area or not txt_phone or not btn_insert:
            raise RuntimeError('Nao foi possivel localizar os campos de inclusao de telefone na aba Telefones.')

        txt_area.clear()
        txt_area.send_keys(ddd)
        txt_phone.clear()
        txt_phone.send_keys(phone)
        driver.execute_script("arguments[0].click();", btn_insert)
        time.sleep(1.5)

        stage = 'confirmar_insercao_telefone'
        WebDriverWait(driver, 8).until(
            lambda d: (
                d.find_elements(By.XPATH, "//table[@id='dgTelephones']//tr[td[normalize-space()='CELULAR']]") or
                d.find_elements(By.XPATH, '/html/body/form/table/tbody/tr[5]/td/table/tbody/tr[2]/td[1][normalize-space()="CELULAR"]')
            )
        )

        stage = 'salvar_cadastro_com_telefone'
        driver.switch_to.default_content()
        vtadmin_switch_main_iframe(driver)
        update_btn = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.ID, 'btnUpdate'))
        )
        driver.execute_script("arguments[0].click();", update_btn)
        vtadmin_accept_duplicate_document_alert(driver, timeout=4)
        driver.switch_to.default_content()
        success_ok_locator = (By.XPATH, '/html/body/form/div/table/tbody/tr[3]/td/input')
        try:
            success_ok = WebDriverWait(driver, 8).until(
                EC.element_to_be_clickable(success_ok_locator)
            )
            driver.execute_script("arguments[0].click();", success_ok)
        except Exception:
            vtadmin_find_ok_and_click(driver)
        vtadmin_switch_main_iframe(driver)

        return {
            'inserted': True,
            'source': source,
            'ddd': ddd,
            'phone_length': len(phone),
        }
    except Exception as exc:
        raise RuntimeError(f"Falha ao garantir telefone na etapa '{stage}': {exc}") from exc


def vtadmin_set_observation(driver, observation_text: str):
    card_hygiene_log("Localizando campo de observacao no VTAdmin")
    field = None
    last_error = None
    search_attempts = [
        ('iframe', lambda: vtadmin_switch_main_iframe(driver)),
        ('pagina_principal', lambda: driver.switch_to.default_content()),
    ]
    locators = [
        (By.ID, "txtObservacao"),
        (By.NAME, "txtObservacao"),
        (By.XPATH, "//textarea[@id='txtObservacao']"),
        (By.XPATH, "//textarea[@name='txtObservacao']"),
    ]

    for context_name, switch_context in search_attempts:
        try:
            switch_context()
            try:
                # Esperar até que a página pareça estar carregada de fato
                WebDriverWait(driver, 8).until(
                    lambda d: any(d.find_elements(*loc) for loc in locators) or d.find_elements(By.ID, "btnUpdate")
                )
            except Exception as exc:
                last_error = exc
            
            end_time = time.time() + 4
            while time.time() < end_time and not field:
                for locator in locators:
                    try:
                        elems = driver.find_elements(*locator)
                        for el in elems:
                            if el.is_displayed():
                                field = el
                                break
                    except Exception:
                        pass
                    if field:
                        break
                if not field:
                    time.sleep(0.2)

            if field:
                card_hygiene_log(f"Campo de observacao encontrado em '{context_name}'")
                break
        except Exception as exc:
            last_error = exc

    if not field:
        raise RuntimeError("Nao foi possivel localizar o campo txtObservacao apos abrir o cartao.") from last_error

    existing = (field.get_attribute('value') or '').strip()
    full_text = (observation_text or '').strip()
    normalized_existing = ' '.join(existing.lower().split())
    normalized_new = ' '.join(full_text.lower().split())
    if normalized_new and normalized_new in normalized_existing:
        full_text = existing
        card_hygiene_log("Observacao ja existia no cadastro; mantendo texto sem duplicar")
    elif existing:
        full_text = f"{full_text}\r\n{existing}" if full_text else existing
    full_text = full_text[:2000]
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", field)
    driver.execute_script(
        "arguments[0].value = arguments[1];"
        "arguments[0].dispatchEvent(new Event('input', { bubbles: true }));"
        "arguments[0].dispatchEvent(new Event('change', { bubbles: true }));",
        field,
        full_text
    )
    card_hygiene_log("Observacao preenchida no cadastro do VTAdmin")


def vtadmin_ensure_birthdate_for_update(driver, cpf: str, job_id: Optional[str] = None) -> Dict[str, Any]:
    cpf_digits = ''.join(ch for ch in str(cpf or '') if ch.isdigit())
    _check_cancelled(job_id, f'{cpf_digits or "cadastro"} / verificar data de nascimento')
    vtadmin_switch_main_iframe(driver)

    field_locators = [
        (By.ID, 'txtDataNascimento'),
        (By.XPATH, '/html/body/form/div/table/tbody/tr/td/fieldset/table/tbody/tr[5]/td[2]/input'),
        (By.ID, 'txtNascimento'),
        (By.ID, 'txtBirthDate'),
        (By.NAME, 'txtDataNascimento'),
        (By.NAME, 'txtNascimento'),
        (By.XPATH, "//tr[td[contains(normalize-space(.), 'Data de Nascimento')]]//input[@type='text'][1]"),
        (By.XPATH, "//td[contains(normalize-space(.), 'Data de Nascimento')]/following-sibling::td[1]//input[@type='text'][1]"),
        (By.XPATH, "//input[@type='text' and contains(@value, '/') and @maxlength='10']"),
    ]

    birthdate_field = None
    for locator in field_locators:
        try:
            candidates = driver.find_elements(*locator)
        except Exception:
            candidates = []
        for candidate in candidates:
            try:
                if candidate.is_displayed() and candidate.is_enabled():
                    birthdate_field = candidate
                    break
            except Exception:
                continue
        if birthdate_field:
            break

    if birthdate_field is None:
        card_hygiene_log("Campo de data de nascimento nao encontrado no VTAdmin; seguindo sem ajuste automatico")
        return {'filled': False, 'source': None, 'birthdate': None, 'field_found': False, 'note': None}

    current_value = normalize_birthdate_for_vtadmin(birthdate_field.get_attribute('value') or '')
    if current_value:
        card_hygiene_log(f"Data de nascimento ja preenchida no VTAdmin ({current_value})")
        return {
            'filled': False,
            'source': 'VTADMIN',
            'birthdate': current_value,
            'field_found': True,
            'note': None,
            'used_existing': True,
        }

    fallback_birthdate = lookup_birthdate_for_hygiene(cpf_digits)
    birthdate_value = fallback_birthdate['birthdate']
    birthdate_source = fallback_birthdate['source']
    birthdate_note = fallback_birthdate.get('note')

    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", birthdate_field)
    birthdate_field.clear()
    driver.execute_script(
        "arguments[0].value = arguments[1];"
        "arguments[0].dispatchEvent(new Event('input', { bubbles: true }));"
        "arguments[0].dispatchEvent(new Event('change', { bubbles: true }));"
        "arguments[0].blur();",
        birthdate_field,
        birthdate_value
    )
    try:
        driver.execute_script("if (typeof FormatDate === 'function') { FormatDate(arguments[0]); }", birthdate_field)
    except Exception:
        pass
    card_hygiene_log(f"Data de nascimento ajustada no VTAdmin com origem {birthdate_source}: {birthdate_value}")
    return {
        'filled': True,
        'source': birthdate_source,
        'birthdate': birthdate_value,
        'field_found': True,
        'note': birthdate_note,
        'used_existing': False,
        'is_default': bool(fallback_birthdate.get('is_default')),
    }


def vtadmin_collect_validation_messages(driver) -> List[str]:
    messages = []
    contexts = [
        ('default', lambda: driver.switch_to.default_content()),
        ('iframe', lambda: vtadmin_switch_main_iframe(driver)),
    ]
    locators = [
        (By.ID, 'vs'),
        (By.ID, 'lblAlertMessage'),
        (By.XPATH, "//*[contains(normalize-space(.), 'Data de Nascimento') and (self::span or self::div or self::td or self::li or self::font)]"),
        (By.XPATH, "//*[contains(normalize-space(.), 'obrigatório') or contains(normalize-space(.), 'Formato Errado') or contains(normalize-space(.), 'inválido')]"),
    ]

    for _, switch_context in contexts:
        try:
            switch_context()
        except Exception:
            continue

        for locator in locators:
            try:
                for element in driver.find_elements(*locator):
                    text_value = ' '.join((element.text or '').split())
                    if not text_value or len(text_value) > 220:
                        continue
                    if text_value in {
                        'UCA', 'Módulo Cliente', 'Bureau', 'Financeiro', 'Segurança', 'Sys',
                        'Serviços', 'Configuração', 'Relatórios', 'Agendamento', 'Portal'
                    }:
                        continue
                    if 'Cadastro de Usuários >> Incluir/Atualizar' in text_value:
                        continue
                    if text_value not in messages:
                        messages.append(text_value)
            except Exception:
                continue

    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    return messages


def vtadmin_collect_validation_messages_strict(driver) -> List[str]:
    messages: List[str] = []
    error_keywords = ('obrigat', 'formato errado', 'invalido', 'inválido', 'erro')
    contexts = [
        lambda: driver.switch_to.default_content(),
        lambda: vtadmin_switch_main_iframe(driver),
    ]
    locators = [
        (By.ID, 'vs'),
        (By.ID, 'lblAlertMessage'),
        (By.XPATH, "//*[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÀÃÂÉÊÍÓÔÕÚÇ', 'abcdefghijklmnopqrstuvwxyzáàãâéêíóôõúç'), 'obrigat') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÀÃÂÉÊÍÓÔÕÚÇ', 'abcdefghijklmnopqrstuvwxyzáàãâéêíóôõúç'), 'formato errado') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÀÃÂÉÊÍÓÔÕÚÇ', 'abcdefghijklmnopqrstuvwxyzáàãâéêíóôõúç'), 'invalido') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÀÃÂÉÊÍÓÔÕÚÇ', 'abcdefghijklmnopqrstuvwxyzáàãâéêíóôõúç'), 'inválido') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÀÃÂÉÊÍÓÔÕÚÇ', 'abcdefghijklmnopqrstuvwxyzáàãâéêíóôõúç'), 'erro')]"),
    ]

    for switch_context in contexts:
        try:
            switch_context()
        except Exception:
            continue
        for locator in locators:
            try:
                for element in driver.find_elements(*locator):
                    text_value = ' '.join((element.text or '').split())
                    if not text_value or len(text_value) > 220:
                        continue
                    lowered = text_value.lower()
                    if not any(keyword in lowered for keyword in error_keywords):
                        continue
                    if text_value in {
                        'Data de Nascimento:',
                        'Nome:',
                        'Nome da Mãe:',
                        'Nome do Pai:',
                        'Responsável:',
                        'Observação:',
                        'Sexo:',
                        'Status:',
                        'Nacionalidade:',
                        'Estado Civil:',
                        'Renda Pessoal:',
                        'Renda Familiar:',
                        'Renda Mensal:',
                        'Escolaridade:',
                    }:
                        continue
                    if text_value not in messages:
                        messages.append(text_value)
            except Exception:
                continue

    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    return messages


def vtadmin_accept_duplicate_document_alert(driver, timeout: int = 3) -> bool:
    try:
        alert = WebDriverWait(driver, timeout).until(EC.alert_is_present())
    except TimeoutException:
        return False
    except Exception:
        return False

    try:
        alert_text = alert.text or ''
    except Exception:
        alert_text = ''

    normalized = alert_text.lower()
    should_accept = (
        'já existe um usuário cadastrado com o documento' in normalized
        or 'ja existe um usuario cadastrado com o documento' in normalized
    ) and 'deseja continuar' in normalized

    if not should_accept:
        return False

    alert.accept()
    card_hygiene_log(f"Alerta de documento duplicado aceito automaticamente: {alert_text}")
    return True


def vtadmin_send_to_hotlist(driver, card_number: str, job_id: Optional[str] = None):
    card_hygiene_log(f"Abrindo hotlist do cartao {card_number}")
    update_job_progress(
        job_id,
        progress_label='Abrindo tela de lista de restrição',
        progress_detail=f'Preparando a tela de hotlist do cartão {card_number}.',
    )
    substep = 'clicar_enviar'
    try:
        _check_cancelled(job_id, f'{card_number} / abrir hotlist')
        vtadmin_switch_main_iframe(driver)
        send_link, status_text = vtadmin_find_hotlist_send_link_for_card(driver, card_number)
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", send_link)
        driver.execute_script("arguments[0].click();", send_link)
        card_hygiene_log(
            f"Link 'Enviar' acionado na linha exata do cartao {card_number}"
            + (f" (status '{status_text}')" if status_text else "")
        )

        substep = 'selecionar_motivo'
        _check_cancelled(job_id, f'{card_number} / selecionar motivo')
        vtadmin_switch_main_iframe(driver)
        motivo = WebDriverWait(driver, 20).until(
            EC.presence_of_element_located((By.ID, "cboMotivo"))
        )
        Select(motivo).select_by_value(VTADMIN_HOTLIST_REASON_VALUE)
        WebDriverWait(driver, 10).until(
            lambda d: d.find_element(By.ID, "cboMotivo").get_attribute("value") == VTADMIN_HOTLIST_REASON_VALUE
        )
        card_hygiene_log("Motivo HIGIENIZACAO DE CADASTRO selecionado")
        update_job_progress(
            job_id,
            progress_label='Selecionando motivo da restrição',
            progress_detail='Motivo HIGIENIZAÇÃO DE CADASTRO selecionado no VTAdmin.',
        )

        substep = 'confirmar_hotlist'
        _check_cancelled(job_id, f'{card_number} / confirmar hotlist')
        WebDriverWait(driver, 20).until(
            EC.element_to_be_clickable((By.ID, "btnConfirmar"))
        ).click()
        card_hygiene_log("Confirmacao da lista negra enviada")
        update_job_progress(
            job_id,
            progress_label='Confirmando inclusão na restrição',
            progress_detail=f'Inclusão do cartão {card_number} na lista de restrição confirmada.',
        )

        substep = 'ok_hotlist'
        _check_cancelled(job_id, f'{card_number} / confirmar alerta da hotlist')
        vtadmin_find_ok_and_click(driver)
        card_hygiene_log("Alerta de inclusao na lista negra confirmado")
        update_job_progress(
            job_id,
            progress_label='Consolidando atualização...',
            progress_detail='Hotlist concluída. Voltando para registrar a observação e salvar o cadastro.',
        )
    except Exception as exc:
        raise RuntimeError(f"Falha ao {substep} para o cartao {card_number}: {exc}") from exc


def vtadmin_click_update(driver, job_id: Optional[str] = None):
    btn = None
    for _ in range(3):
        try:
            _check_cancelled(job_id, 'localizar botão Atualizar')
            vtadmin_switch_main_iframe(driver)
            btn = WebDriverWait(driver, 8).until(
                EC.element_to_be_clickable((By.ID, "btnUpdate"))
            )
            break
        except Exception:
            driver.switch_to.default_content()
            driver.back()
            time.sleep(1)

    if btn is None:
        raise RuntimeError('Nao foi possivel localizar o botao Atualizar apos enviar para hotlist.')

    _check_cancelled(job_id, 'clicar em Atualizar')
    update_job_progress(
        job_id,
        progress_label='Gravando alterações...',
        progress_detail='Executando o botão Atualizar e aguardando a confirmação final.',
    )
    btn.click()
    vtadmin_accept_duplicate_document_alert(driver, timeout=4)
    validation_messages = vtadmin_collect_validation_messages_strict(driver)
    if validation_messages:
        raise RuntimeError(f"Erro cadastral no VTAdmin: {' | '.join(validation_messages[:3])}")
    _check_cancelled(job_id, 'confirmar alerta do Atualizar')
    vtadmin_find_ok_and_click(driver)
    card_hygiene_log("Cadastro atualizado no VTAdmin")


def build_card_result_note(phone_result: Optional[Dict[str, Any]] = None,
                           birthdate_result: Optional[Dict[str, Any]] = None) -> str:
    notes: List[str] = []
    if birthdate_result:
        birthdate_note = (birthdate_result.get('note') or '').strip()
        if birthdate_note:
            notes.append(birthdate_note)
    if phone_result:
        if phone_result.get('inserted'):
            source = phone_result.get('source') or 'DESCONHECIDA'
            notes.append(f"Telefone inserido automaticamente via base {source}.")
    return ' '.join(notes).strip()


def _check_cancelled(job_id: Optional[str], step: str = 'processamento'):
    """Raise CardHygieneCancelled if the job was cancelled via DB."""
    if not job_id:
        return
    if is_job_cancelled_in_db(job_id):
        raise CardHygieneCancelled(f"Cancelado pelo usuário durante {step}.")


def _compute_percent(item_index: int, total_items: int, stage_fraction: float) -> int:
    total_items = max(int(total_items or 0), 1)
    stage_fraction = max(0.0, min(float(stage_fraction), 1.0))
    overall = 8 + (((item_index + stage_fraction) / total_items) * 92)
    return max(1, min(100, int(round(overall))))


# ---------------------------------------------------------------------------
# Main background worker
# ---------------------------------------------------------------------------

def _hygiene_worker(job_id: str, selected_items: List[Dict[str, Any]],
                    observation: str, user_id: int, username: str,
                    vtadmin_username: str, vtadmin_password: str,
                    filters: Optional[Dict[str, Any]] = None):
    """
    Runs in a daemon thread. Persists all progress to DB so it survives
    browser closes, logouts and page reloads.
    """
    driver = None
    success_items = []
    failed_items = []
    skipped_items = []
    cancelled = False
    total = len(selected_items)

    try:
        update_job_progress(job_id,
                            status='running',
                            progress_percent=2,
                            progress_label='Abrindo sessão do VTAdmin...',
                            progress_detail='Preparando o navegador para iniciar a higienização.',
                            processed=0,
                            total=total)

        driver = create_vtadmin_driver()
        update_job_progress(job_id,
                            progress_percent=6,
                            progress_label='Validando acesso...',
                            progress_detail='Confirmando credenciais e preparando o ambiente.')
        vtadmin_login(driver, job_id, vtadmin_username, vtadmin_password)

        for index, item in enumerate(selected_items):
            card_number = str(item.get('cartao') or '').strip()
            cpf = str(item.get('cpf') or '').strip()
            current_step = 'inicializando'
            phone_result = None
            birthdate_result = None
            row_info = None
            try:
                pct = _compute_percent(index, total, 0.05)
                update_job_progress(job_id,
                                    status='running',
                                    progress_percent=pct,
                                    progress_label='Acessando registro selecionado',
                                    progress_detail=f'Iniciando a higienização do cartão {card_number}.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index)
                _check_cancelled(job_id, f'antes de iniciar {card_number}')
                card_hygiene_log(f"Iniciando higienizacao do cartao {card_number} (CPF {cpf})")

                current_step = 'abrir_cartao'
                row_info = vtadmin_open_card(driver, card_number, cpf)
                status_text = (row_info or {}).get('status') or ''
                normalized_status = normalize_vtadmin_card_status(status_text)
                if normalized_status in {'INATIVO', 'EM LISTA DE RESTRICAO'}:
                    raise CardHygieneSkipped(
                        f"Cartao {card_number} ignorado porque ja estava com status '{status_text}'.",
                        status_text=status_text,
                    )

                pct = _compute_percent(index, total, 0.30)
                update_job_progress(job_id,
                                    progress_percent=pct,
                                    progress_label='Cartão localizado no VTAdmin',
                                    progress_detail=f'Cadastro e cartão {card_number} encontrados. Preparando a inclusão na lista de restrição.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index)
                _check_cancelled(job_id, f'{card_number} / após abrir cartão')

                current_step = 'garantir_data_nascimento'
                update_job_progress(job_id,
                                    progress_percent=_compute_percent(index, total, 0.38),
                                    progress_label='Verificando data de nascimento',
                                    progress_detail=f'Checando se o CPF {cpf} possui data de nascimento valida antes da higienizacao.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index)
                birthdate_result = vtadmin_ensure_birthdate_for_update(driver, cpf, job_id)
                birthdate_source = (birthdate_result or {}).get('source')
                if birthdate_source:
                    card_hygiene_log(f"Data de nascimento verificada para o cartao {card_number} usando a origem {birthdate_source}")
                _check_cancelled(job_id, f'{card_number} / apos verificar data de nascimento')

                current_step = 'garantir_telefone'
                update_job_progress(job_id,
                                    progress_percent=_compute_percent(index, total, 0.46),
                                    progress_label='Verificando telefone do cadastro',
                                    progress_detail=f'Checando se o CPF {cpf} possui telefone antes de registrar a observacao.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index)
                phone_result = vtadmin_ensure_phone_for_observation(driver, cpf, job_id)
                phone_source = (phone_result or {}).get('source') or 'DESCONHECIDA'
                card_hygiene_log(f"Telefone validado para o cartao {card_number} usando a origem {phone_source}")
                if birthdate_result and birthdate_result.get('filled') and not (phone_result or {}).get('inserted'):
                    current_step = 'salvar_data_nascimento'
                    update_job_progress(job_id,
                                        progress_percent=_compute_percent(index, total, 0.50),
                                        progress_label='Salvando data de nascimento',
                                        progress_detail=f'Data de nascimento ajustada para o cartao {card_number}. Gravando cadastro antes de continuar.',
                                        current_card=card_number,
                                        current_cpf=cpf,
                                        processed=index)
                    vtadmin_click_update(driver, job_id)
                _check_cancelled(job_id, f'{card_number} / apos verificar telefone')

                current_step = 'enviar_para_hotlist'
                vtadmin_send_to_hotlist(driver, card_number, job_id)

                pct = _compute_percent(index, total, 0.62)
                update_job_progress(job_id,
                                    progress_percent=pct,
                                    progress_label='Cartão enviado para lista de restrição',
                                    progress_detail=f'Motivo HIGIENIZAÇÃO DE CADASTRO confirmado para o cartão {card_number}.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index)
                _check_cancelled(job_id, f'{card_number} / após enviar para hotlist')

                current_step = 'preencher_observacao'
                vtadmin_set_observation(driver, observation)

                pct = _compute_percent(index, total, 0.82)
                update_job_progress(job_id,
                                    progress_percent=pct,
                                    progress_label='Registrando observação no cadastro',
                                    progress_detail=f'Observação aplicada ao cartão {card_number}. Finalizando o salvamento.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index)
                _check_cancelled(job_id, f'{card_number} / após preencher observação')

                current_step = 'atualizar_cadastro'
                vtadmin_click_update(driver, job_id)

                card_hygiene_log(f"Higienizacao concluida para o cartao {card_number}")
                success_items.append({
                    'cpf': cpf,
                    'nome': item.get('nome') or '',
                    'cartao': card_number,
                    'note': build_card_result_note(phone_result, birthdate_result),
                    'birthdate_source': (birthdate_result or {}).get('source'),
                    'birthdate': (birthdate_result or {}).get('birthdate'),
                })

                pct = _compute_percent(index, total, 1.0)
                update_job_progress(job_id,
                                    progress_percent=pct,
                                    progress_label='Higienização concluída',
                                    progress_detail=f'Cartão {card_number} concluído com sucesso no VTAdmin.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index + 1)

            except CardHygieneSkipped as exc:
                skipped_reason = str(exc).strip() or 'Cartao ignorado.'
                card_hygiene_log(skipped_reason)
                skipped_items.append({
                    'cpf': cpf,
                    'nome': item.get('nome') or '',
                    'cartao': card_number,
                    'status': getattr(exc, 'status_text', '') or (row_info or {}).get('status') or '',
                    'reason': skipped_reason,
                    'note': build_card_result_note(phone_result, birthdate_result),
                    'birthdate_source': (birthdate_result or {}).get('source'),
                    'birthdate': (birthdate_result or {}).get('birthdate'),
                })
                update_job_progress(job_id,
                                    progress_percent=_compute_percent(index, total, 1.0),
                                    progress_label='Cartao ignorado',
                                    progress_detail=skipped_reason,
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=index + 1)

            except CardHygieneCancelled as exc:
                cancelled = True
                card_hygiene_log(f"Cancelamento confirmado para o cartao {card_number}: {exc}")
                update_job_progress(job_id,
                                    status='cancel_requested',
                                    progress_label='Cancelamento em andamento',
                                    progress_detail='A higienização foi interrompida a pedido do usuário.',
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=len(success_items))
                break

            except Exception as exc:
                formatted_error = format_card_hygiene_exception(current_step, exc)
                card_hygiene_log(f"Falha no cartao {card_number}: {formatted_error}")
                update_job_progress(job_id,
                                    progress_label='Falha no processamento',
                                    progress_detail=formatted_error,
                                    current_card=card_number,
                                    current_cpf=cpf,
                                    processed=len(success_items))
                failed_items.append({
                    'cpf': cpf,
                    'nome': item.get('nome') or '',
                    'cartao': card_number,
                    'error': formatted_error,
                    'note': build_card_result_note(phone_result, birthdate_result),
                    'birthdate_source': (birthdate_result or {}).get('source'),
                    'birthdate': (birthdate_result or {}).get('birthdate'),
                    'traceback': traceback.format_exc(limit=2),
                })
                try:
                    driver.quit()
                except Exception:
                    pass
                driver = create_vtadmin_driver()
                vtadmin_login(driver, job_id, vtadmin_username, vtadmin_password)

        # Persist success log to DB
        if success_items:
            try:
                with engine.connect() as conn:
                    persist_card_hygiene_log(conn, user_id, username, vtadmin_username, observation, success_items, filters)
                    conn.commit()
            except Exception as exc:
                card_hygiene_log(f"[_hygiene_worker] Falha ao persistir log de sucesso: {exc}")

        # Determine final status
        skip_suffix = f' {len(skipped_items)} ignorado(s).' if skipped_items else ''
        if cancelled:
            final_status = 'cancelled'
            final_label = 'Higienização cancelada'
            final_detail = f'{len(success_items)} cartão(ões) processado(s) antes do cancelamento.' + skip_suffix
        elif failed_items and not success_items:
            final_status = 'failed'
            final_label = 'Higienização falhou'
            final_detail = f'Nenhum cartão processado. {len(failed_items)} falha(s).' + skip_suffix
        elif failed_items:
            final_status = 'partial'
            final_label = 'Processamento concluído com ressalvas'
            final_detail = f'{len(success_items)} cartão(ões) processado(s) e {len(failed_items)} falha(s).' + skip_suffix
        else:
            final_status = 'success'
            final_label = 'Higienização concluída'
            final_detail = f'{len(success_items)} cartão(ões) processado(s) com sucesso.' + skip_suffix

        update_job_progress(job_id,
                            progress_percent=100,
                            progress_label=final_label,
                            progress_detail=final_detail,
                            processed=len(success_items))
        finish_job(job_id, final_status, {
            'success_count': len(success_items),
            'failure_count': len(failed_items),
            'skip_count': len(skipped_items),
            'cancelled': cancelled,
            'success_items': success_items,
            'failed_items': failed_items,
            'skipped_items': skipped_items,
        })

    except Exception as exc:
        card_hygiene_log(f"[_hygiene_worker] Erro fatal no job {job_id}: {exc}")
        try:
            finish_job(job_id, 'failed', {
                'error': str(exc),
                'success_items': success_items,
                'failed_items': failed_items,
                'skipped_items': skipped_items,
            })
        except Exception:
            pass
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


def start_hygiene_background_job(job_id: str, selected_items: List[Dict[str, Any]],
                                  observation: str, user_id: int, username: str,
                                  vtadmin_username: str, vtadmin_password: str,
                                  filters: Optional[Dict[str, Any]] = None):
    """Launch a daemon thread for the hygiene job and return immediately."""
    t = threading.Thread(
        target=_hygiene_worker,
        args=(job_id, selected_items, observation, user_id, username, vtadmin_username, vtadmin_password, filters),
        daemon=True,
        name=f"hygiene-{job_id[:12]}"
    )
    t.start()
    card_hygiene_log(f"Job {job_id} iniciado em background thread {t.name}")
    return t


# ---------------------------------------------------------------------------
# Refresh hidden cards status (unchanged)
# ---------------------------------------------------------------------------

def refresh_hidden_cards_status(conn, card_numbers: Optional[List[str]] = None, max_cards: int = 10):
    ensure_card_hygiene_tables(conn)

    params = {}
    sql = """
        SELECT card_number, cpf
        FROM databridge_web.databridge_card_hygiene_hidden_cards
        WHERE is_active = 1
    """
    if card_numbers:
        placeholders = []
        for idx, card_number in enumerate(card_numbers):
            key = f"card_{idx}"
            placeholders.append(f":{key}")
            params[key] = str(card_number).strip()
        if placeholders:
            sql += f" AND card_number IN ({', '.join(placeholders)})"
    sql += " ORDER BY COALESCE(last_checked_at, '1900-01-01') ASC, hidden_at DESC LIMIT :limit"
    params['limit'] = int(max_cards)

    rows = conn.execute(text(sql), params).mappings().fetchall()
    if not rows:
        return 0

    driver = None
    refreshed = 0
    try:
        driver = create_vtadmin_driver()
        vtadmin_login(driver)
        for row in rows:
            card_number = str(row.get('card_number') or '').strip()
            cpf = str(row.get('cpf') or '').strip()
            if not card_number:
                continue
            try:
                vtadmin_open_card(driver, card_number, cpf)
                action = vtadmin_get_hotlist_action(driver, card_number)
                card_hygiene_log(f"Status atual da lista de restricao do cartao {card_number}: {action or 'nao identificado'}")
                if action == 'Enviar':
                    conn.execute(text("""
                        UPDATE databridge_web.databridge_card_hygiene_hidden_cards
                        SET is_active = 0,
                            last_checked_at = CURRENT_TIMESTAMP,
                            last_known_hotlist_action = :action,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE card_number = :card_number
                    """), {'card_number': card_number, 'action': action})
                else:
                    conn.execute(text("""
                        UPDATE databridge_web.databridge_card_hygiene_hidden_cards
                        SET last_checked_at = CURRENT_TIMESTAMP,
                            last_known_hotlist_action = :action,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE card_number = :card_number
                    """), {'card_number': card_number, 'action': action or 'desconhecido'})
                refreshed += 1
            except Exception as exc:
                card_hygiene_log(f"Falha ao sincronizar status do cartao oculto {card_number}: {exc}")
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass

    return refreshed
