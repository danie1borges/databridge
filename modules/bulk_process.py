import os
import re
import json
import uuid as _uuid
import threading
import pandas as pd
from flask import Blueprint, request, session, jsonify
from sqlalchemy import text
from core.config import UPLOAD_FOLDER
from core.database import engine, clean_cpf
from modules.auth import user_has_permission, login_required

bulk_bp = Blueprint('bulk', __name__)


# ─── Job persistence ──────────────────────────────────────────────────────────

def _ensure_bulk_jobs_table(conn):
    conn.execute(text(
        "CREATE DATABASE IF NOT EXISTS databridge_web "
        "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    ))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS databridge_web.databridge_bulk_jobs (
            id          VARCHAR(36)  NOT NULL,
            user_id     INT          NOT NULL,
            username    VARCHAR(100) DEFAULT '',
            filename    VARCHAR(255) DEFAULT '',
            status      VARCHAR(20)  DEFAULT 'running',
            progress    INT          DEFAULT 0,
            progress_msg VARCHAR(500) DEFAULT '',
            download_url VARCHAR(255) NULL,
            error_msg   TEXT         NULL,
            total_cpfs  INT          DEFAULT 0,
            created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            INDEX idx_bulk_user (user_id)
        )
    """))


def create_bulk_job(user_id, username, filename, total_cpfs):
    job_id = str(_uuid.uuid4())
    try:
        with engine.connect() as conn:
            _ensure_bulk_jobs_table(conn)
            conn.execute(text("""
                INSERT INTO databridge_web.databridge_bulk_jobs
                    (id, user_id, username, filename, total_cpfs)
                VALUES (:id, :uid, :usr, :fn, :total)
            """), {'id': job_id, 'uid': user_id, 'usr': username,
                   'fn': filename, 'total': total_cpfs})
            conn.commit()
    except Exception as e:
        print(f'[bulk_job] create error: {e}')
    return job_id


def update_bulk_job(job_id, progress, msg, status='running',
                    download_url=None, error_msg=None, total_cpfs=None):
    try:
        with engine.connect() as conn:
            extra = ', total_cpfs=:tc' if total_cpfs is not None else ''
            params = {'p': progress, 'msg': msg, 'st': status,
                      'dl': download_url, 'em': error_msg, 'id': job_id}
            if total_cpfs is not None:
                params['tc'] = total_cpfs
            conn.execute(text(f"""
                UPDATE databridge_web.databridge_bulk_jobs
                SET progress=:p, progress_msg=:msg, status=:st,
                    download_url=:dl, error_msg=:em{extra}
                WHERE id=:id
            """), params)
            conn.commit()
    except Exception as e:
        print(f'[bulk_job] update error: {e}')


def get_bulk_job(job_id):
    try:
        with engine.connect() as conn:
            row = conn.execute(text("""
                SELECT id, user_id, username, filename, status,
                       progress, progress_msg, download_url, error_msg, total_cpfs,
                       created_at, updated_at
                FROM databridge_web.databridge_bulk_jobs
                WHERE id = :id
            """), {'id': job_id}).mappings().fetchone()
            return dict(row) if row else None
    except Exception as e:
        print(f'[bulk_job] get error: {e}')
        return None


@bulk_bp.route('/api/bulk/status/<job_id>', methods=['GET'])
@login_required
def bulk_job_status(job_id):
    job = get_bulk_job(job_id)
    if not job:
        return jsonify({'found': False}), 200
    if job['user_id'] != session.get('user_id'):
        return jsonify({'error': 'Acesso negado'}), 403
    return jsonify({
        'found':        True,
        'status':       job['status'],
        'progress':     job['progress'],
        'msg':          job['progress_msg'],
        'download_url': job['download_url'],
        'error_msg':    job['error_msg'],
    }), 200


def normalize_phone(raw):
    """Normaliza telefone para (XX) XXXXX-XXXX. Retorna (formatado, foi_alterado)."""
    if pd.isna(raw) or not str(raw).strip():
        return None, False
    original = str(raw).strip()
    digits = re.sub(r'\D', '', original)
    if digits.startswith('55') and len(digits) >= 12:
        digits = digits[2:]
    if len(digits) == 10:
        digits = digits[:2] + '9' + digits[2:]   # falta o 9 do celular
    elif len(digits) == 9:
        digits = '92' + digits                    # sem DDD, assume regional
    elif len(digits) == 8:
        digits = '92' + digits                    # fixo sem DDD
    if len(digits) == 11:
        formatted = f"({digits[:2]}) {digits[2:7]}-{digits[7:]}"
    elif len(digits) == 10:
        formatted = f"({digits[:2]}) {digits[2:6]}-{digits[6:]}"
    else:
        return original, False
    return formatted, (formatted != original)


def is_fake_email(email):
    """Detecta placeholder @cadunico usado pela Portal Cliente."""
    if pd.isna(email) or not str(email).strip():
        return False
    return '@cadunico' in str(email).lower()


def _safe_val(val):
    """Retorna None se val for NaN/None/vazio, caso contrário retorna str."""
    if val is None:
        return None
    try:
        if pd.isna(val):
            return None
    except (TypeError, ValueError):
        pass
    s = str(val).strip()
    return s if s else None


def _best_name(row):
    return _safe_val(row.get('nome_mec')) or _safe_val(row.get('nome_abt')) or '—'


def register_socketio_events(socketio):
    @socketio.on('iniciar_processamento')
    def handle_process(data):
        if 'user_id' not in session or not user_has_permission('cruzamento'):
            socketio.emit('status', {'msg': 'Acesso negado para cruzamento em massa.', 'progress': 0}, to=request.sid)
            return

        user_sid  = request.sid
        username  = session.get('username') or 'Desconhecido'
        user_id   = session.get('user_id')
        filename  = os.path.basename(data.get('filename') or '')
        job_id    = create_bulk_job(user_id, username, filename, 0)
        task_data = {'filename': filename, 'job_id': job_id}

        # Confirm job_id to frontend BEFORE spawning thread
        socketio.emit('job_started', {'job_id': job_id}, to=user_sid)

        t = threading.Thread(target=process_task, args=(socketio, task_data, user_sid, username, user_id))
        t.daemon = True
        t.start()

def _emit(socketio, user_sid, job_id, event, payload):
    """Emite via socket E persiste estado no DB para fallback de polling."""
    socketio.emit(event, payload, to=user_sid)
    if event == 'status':
        update_bulk_job(job_id, payload.get('progress', 0), payload.get('msg', ''))
    elif event == 'finalizado':
        update_bulk_job(job_id, 100, 'Concluído',
                        status='done', download_url=payload.get('download_url'))


def process_task(socketio, data, user_sid, username, user_id):
    job_id = data.get('job_id', '')
    try:
        filename = data['filename']
        filepath = os.path.join(UPLOAD_FOLDER, filename)

        # ── 1. Ler planilha PRIMEIRO para construir o WHERE IN ──────────────
        _emit(socketio, user_sid, job_id, 'status',
              {'msg': 'Lendo sua planilha...', 'progress': 10})
        if filename.lower().endswith('.csv'):
            df_user = pd.read_csv(filepath, sep=None, engine='python', dtype={0: str}, encoding='latin1')
        else:
            df_user = pd.read_excel(filepath, dtype={0: str})

        total_p = len(df_user)
        col_cpf = df_user.columns[0]
        df_user['cpf_key'] = df_user[col_cpf].apply(clean_cpf)

        cpf_list = [c for c in df_user['cpf_key'].dropna().unique().tolist() if c and len(c) == 11]
        if not cpf_list:
            update_bulk_job(job_id, 0, 'Nenhum CPF válido', status='error',
                            error_msg='Nenhum CPF válido encontrado na planilha.')
            socketio.emit('status', {'msg': 'Nenhum CPF válido encontrado na planilha.', 'progress': 0}, to=user_sid)
            return
        if len(cpf_list) > 300000:
            msg = f'Limite excedido: {len(cpf_list):,} CPFs únicos. Máximo permitido: 300.000.'
            update_bulk_job(job_id, 0, msg, status='error', error_msg=msg)
            socketio.emit('status', {'msg': msg, 'progress': 0}, to=user_sid)
            return

        update_bulk_job(job_id, 10, 'Lendo planilha', total_cpfs=total_p)

        # CPFs são puramente numéricos após clean_cpf → safe para interpolação SQL
        cpfs_in = "'" + "','".join(cpf_list) + "'"

        # ── 2. Queries com WHERE IN — busca apenas os CPFs da planilha ──────
        with engine.connect() as conn:
            _emit(socketio, user_sid, job_id, 'status',
                  {'msg': f'Buscando {total_p} CPF(s) na Portal Cliente...', 'progress': 20})
            q_c = f"""SELECT DISTINCT REPLACE(REPLACE(cpf, '.', ''), '-', '') as cpf_limpo,
                             cellphone as celular_cliente, email as email_cliente
                      FROM app_cliente.customer
                      WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') IN ({cpfs_in})"""
            df_c = pd.read_sql(q_c, conn).drop_duplicates('cpf_limpo')

            _emit(socketio, user_sid, job_id, 'status',
                  {'msg': 'Buscando em Portal Estudante...', 'progress': 32})
            q_e = f"""SELECT DISTINCT cpf as cpf_limpo, celular as celular_estudante, email as email_estudante
                      FROM databridge_db.alunos
                      WHERE cpf IN ({cpfs_in})"""
            df_e = pd.read_sql(q_e, conn).drop_duplicates('cpf_limpo')

            _emit(socketio, user_sid, job_id, 'status',
                  {'msg': 'Buscando em ABT...', 'progress': 44})
            q_a = f"""SELECT REPLACE(REPLACE(documento, '.', ''), '-', '') as cpf_limpo,
                             nome as nome_abt, email as email_abt, celular as celular_abt,
                             bairro as bairro_abt, status as status_abt, data_cadastro as data_cadastro_abt
                      FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY documento ORDER BY data_cadastro DESC) as rank_recente
                            FROM app_vendas.COM_CLIENTES_ABT) as sub
                      WHERE rank_recente = 1
                        AND REPLACE(REPLACE(documento, '.', ''), '-', '') IN ({cpfs_in})"""
            df_a = pd.read_sql(q_a, conn).drop_duplicates('cpf_limpo')

            _emit(socketio, user_sid, job_id, 'status',
                  {'msg': 'Buscando em Wifi Max...', 'progress': 56})
            q_w = f"""SELECT CPF as cpf_limpo, MAX(EMAIL) as email_wifi, MAX(TELEFONE) as celular_wifi
                      FROM app_vendas.WIFIMAX_USERS
                      WHERE CPF IN ({cpfs_in})
                      GROUP BY CPF"""
            df_w = pd.read_sql(q_w, conn).drop_duplicates('cpf_limpo')

            _emit(socketio, user_sid, job_id, 'status',
                  {'msg': 'Buscando em WhatsApp...', 'progress': 65})
            q_zap = f"""SELECT DISTINCT cpf as cpf_limpo, telefone as celular_whatsapp
                        FROM app_vendas.CLIENTES_WHATSAPP
                        WHERE cpf IN ({cpfs_in})"""
            df_zap = pd.read_sql(q_zap, conn).drop_duplicates('cpf_limpo')

            _emit(socketio, user_sid, job_id, 'status',
                  {'msg': 'Buscando em LegacyDB...', 'progress': 74})
            q_cad = f"""SELECT cpf as cpf_limpo, nome as nome_mec, data_nascimento as nascido_mec,
                               email as email_mec, telefone as celular_mec,
                               endereco as endereco_mec, cartoes_json as cad_unico_json
                        FROM app_vendas.SALES_CAD_UNICO_JSON
                        WHERE cpf IN ({cpfs_in})"""
            df_cad = pd.read_sql(q_cad, conn).drop_duplicates('cpf_limpo')

        # ── 3. Merge (left join preserva todos os CPFs da planilha) ─────────
        _emit(socketio, user_sid, job_id, 'status',
              {'msg': 'Cruzando resultados...', 'progress': 82})
        df_final = df_user.copy()
        for df_base in [df_c, df_e, df_a, df_w, df_zap, df_cad]:
            df_final = df_final.merge(df_base, left_on='cpf_key', right_on='cpf_limpo', how='left').drop(columns=['cpf_limpo'], errors='ignore')

        _emit(socketio, user_sid, job_id, 'status',
              {'msg': 'Normalizando telefones...', 'progress': 87})

        # --- Normalização de telefones (vetorizado) ---
        phone_cols = ['celular_mec', 'celular_cliente', 'celular_estudante',
                      'celular_abt', 'celular_wifi', 'celular_whatsapp']
        phones_normalized_count = 0
        for col in phone_cols:
            if col in df_final.columns:
                res = df_final[col].apply(normalize_phone)
                df_final[col] = res.apply(lambda x: x[0])
                phones_normalized_count += int(res.apply(lambda x: x[1]).sum())

        # --- Melhor telefone (vetorizado com fillna em cascata) ---
        tel_order = ['celular_whatsapp', 'celular_mec', 'celular_cliente',
                     'celular_abt', 'celular_wifi', 'celular_estudante']
        melhor_tel = pd.Series([None] * len(df_final), dtype=object, index=df_final.index)
        for c in tel_order:
            if c in df_final.columns:
                valido = df_final[c].where(df_final[c].notna() & (df_final[c].astype(str).str.strip() != '') & (df_final[c].astype(str) != 'None'))
                melhor_tel = melhor_tel.fillna(valido)
        df_final['MELHOR_Telefone'] = melhor_tel

        # --- Melhor e-mail (vetorizado, ignora @cadunico) ---
        email_order = ['email_abt', 'email_estudante', 'email_wifi', 'email_mec', 'email_cliente']
        melhor_email = pd.Series([None] * len(df_final), dtype=object, index=df_final.index)
        for c in email_order:
            if c in df_final.columns:
                valido = df_final[c].where(df_final[c].notna() & ~df_final[c].apply(is_fake_email))
                melhor_email = melhor_email.fillna(valido)
        df_final['MELHOR_Email'] = melhor_email

        # --- Stats de qualidade ---
        emails_falsos_count = int(df_final['email_cliente'].apply(is_fake_email).sum()) \
            if 'email_cliente' in df_final.columns else 0

        base_cols_check = ['cad_unico_json', 'email_cliente', 'email_estudante',
                           'email_abt', 'email_wifi', 'celular_whatsapp']
        multi_base_count = int(
            pd.DataFrame({c: df_final.get(c, pd.Series(dtype=str)).notna()
                          for c in base_cols_check}).sum(axis=1).ge(2).sum()
        )

        stats = {
            'total_planilha': total_p,
            'cliente':   int(df_final['email_cliente'].notna().sum()),
            'estudante': int(df_final['email_estudante'].notna().sum()),
            'abt':       int(df_final['email_abt'].notna().sum()),
            'wifi':      int(df_final['email_wifi'].notna().sum()),
            'whatsapp':  int(df_final['celular_whatsapp'].notna().sum()),
            'cad_unico': int(df_final['cad_unico_json'].notna().sum()),
            'total_geral': int(df_final[['email_cliente', 'email_estudante', 'email_abt',
                                          'email_wifi', 'celular_whatsapp', 'cad_unico_json']]
                               .notna().any(axis=1).sum()),
            'phones_normalized': phones_normalized_count,
            'emails_falsos':     emails_falsos_count,
            'multi_base':        multi_base_count,
        }

        # --- Feed ao vivo em batches (90-95%) ---
        _emit(socketio, user_sid, job_id, 'status',
              {'msg': 'Transmitindo prévia ao vivo...', 'progress': 91})
        batch_size = 100
        total_rows = len(df_final)
        for batch_start in range(0, total_rows, batch_size):
            batch = df_final.iloc[batch_start:batch_start + batch_size]
            records = []
            for _, row in batch.iterrows():
                found_any = any([
                    pd.notna(row.get('cad_unico_json')) and row.get('cad_unico_json'),
                    pd.notna(row.get('email_cliente')),
                    pd.notna(row.get('email_estudante')),
                    pd.notna(row.get('email_abt')),
                    pd.notna(row.get('email_wifi')),
                    pd.notna(row.get('celular_whatsapp')),
                ])
                records.append({
                    'cpf':      str(row.get(col_cpf, '')),
                    'nome':     _best_name(row),
                    'telefone': str(row.get('MELHOR_Telefone') or '—'),
                    'found':    bool(found_any),
                    'bases': {
                        'legacydb':   bool(pd.notna(row.get('cad_unico_json')) and row.get('cad_unico_json')),
                        'cliente':   bool(pd.notna(row.get('email_cliente'))),
                        'estudante': bool(pd.notna(row.get('email_estudante'))),
                        'abt':       bool(pd.notna(row.get('email_abt'))),
                        'wifi':      bool(pd.notna(row.get('email_wifi'))),
                        'whatsapp':  bool(pd.notna(row.get('celular_whatsapp'))),
                    }
                })
            processed = min(batch_start + batch_size, total_rows)
            prog = 91 + int((processed / total_rows) * 4)  # 91-95%
            socketio.emit('parcial_resultado', {
                'records': records, 'processed': processed, 'total': total_rows, 'progress': prog
            }, to=user_sid)

        # --- Preview para o resultado final (20 linhas) ---
        preview_rows = []
        for _, row in df_final.head(10).iterrows():
            preview_rows.append({
                'cpf':        str(row.get(col_cpf, '')),
                'nome':       _best_name(row),
                'telefone':   str(row.get('MELHOR_Telefone') or '—'),
                'email':      str(row.get('MELHOR_Email') or '—'),
                'email_fake': is_fake_email(row.get('email_cliente')),
                'bases': {
                    'legacydb':   bool(pd.notna(row.get('cad_unico_json')) and row.get('cad_unico_json')),
                    'cliente':   bool(pd.notna(row.get('email_cliente'))),
                    'estudante': bool(pd.notna(row.get('email_estudante'))),
                    'abt':       bool(pd.notna(row.get('email_abt'))),
                    'wifi':      bool(pd.notna(row.get('email_wifi'))),
                    'whatsapp':  bool(pd.notna(row.get('celular_whatsapp'))),
                }
            })

        _emit(socketio, user_sid, job_id, 'status',
              {'msg': 'Gerando arquivo final...', 'progress': 95})

        # Parse the raw JSON cards into readable text
        def parse_cards_to_text(jstr):
            if pd.isna(jstr) or not jstr:
                return ''
            try:
                data = json.loads(jstr)
                resumo = []
                for _, apps in data.items():
                    for app_name, app_data in apps.items():
                        saldo_str = '0,00'
                        if isinstance(app_data, dict):
                            first_v = next(iter(app_data.values()), {})
                            s = first_v.get('saldo', 0)
                            if s is not None:
                                saldo_str = f"{s:.2f}".replace('.', ',')
                        resumo.append(f"{app_name} (R$ {saldo_str})")
                return " | ".join(resumo)
            except:
                return jstr

        df_final['Resumo_Cartoes_LegacyDB'] = df_final['cad_unico_json'].apply(parse_cards_to_text)

        base_user_cols = [c for c in df_user.columns if c != 'cpf_key']

        def _pick(df, col_map):
            """Seleciona e renomeia colunas existentes."""
            pairs = [(s, d) for s, d in col_map if s in df.columns]
            return df[[s for s, _ in pairs]].rename(columns=dict(pairs)).fillna('')

        def _write_sheet(writer, workbook, df, sheet_name, hdr_bg):
            if df.empty:
                return
            df.to_excel(writer, sheet_name=sheet_name, index=False)
            ws  = writer.sheets[sheet_name]
            hdr = workbook.add_format({'bold': True, 'bg_color': hdr_bg,
                                       'font_color': 'white', 'border': 1,
                                       'border_color': '#334155', 'valign': 'vcenter'})
            for i, col in enumerate(df.columns):
                ws.write(0, i, col, hdr)
                ws.set_column(i, i, 24)
            ws.freeze_panes(1, 0)
            ws.set_row(0, 22)

        output_name = f"RES_ANALISE_{filename.split('.')[0]}.xlsx"
        output_path = os.path.join(UPLOAD_FOLDER, output_name)

        with pd.ExcelWriter(output_path, engine='xlsxwriter') as writer:
            workbook = writer.book

            # ── Aba 1: Resumo ──────────────────────────────────────────────
            df_resumo = df_final[base_user_cols + ['MELHOR_Telefone', 'MELHOR_Email']].copy()
            df_resumo.rename(columns={'MELHOR_Telefone': 'Melhor Telefone',
                                      'MELHOR_Email':    'Melhor E-mail'}, inplace=True)
            df_resumo['LegacyDB']         = df_final['cad_unico_json'].notna() & (df_final['cad_unico_json'] != '')
            df_resumo['Portal Cliente'] = df_final['email_cliente'].notna()
            df_resumo['Portal Estudante']   = df_final['email_estudante'].notna()
            df_resumo['ABT']             = df_final['email_abt'].notna()
            df_resumo['Wifi Max']        = df_final['email_wifi'].notna()
            df_resumo['WhatsApp']        = df_final['celular_whatsapp'].notna()
            base_cols_bool = ['LegacyDB', 'Portal Cliente', 'Portal Estudante', 'ABT', 'Wifi Max', 'WhatsApp']
            for bc in base_cols_bool:
                df_resumo[bc] = df_resumo[bc].map({True: 'SIM', False: ''})
            df_resumo.fillna('', inplace=True)
            df_resumo.to_excel(writer, sheet_name='Resumo', index=False)

            ws_r   = writer.sheets['Resumo']
            hdr_r  = workbook.add_format({'bold': True, 'bg_color': '#1E293B', 'font_color': 'white',
                                          'border': 1, 'border_color': '#334155', 'valign': 'vcenter'})
            sim_f  = workbook.add_format({'bold': True, 'bg_color': '#D1FAE5', 'font_color': '#065F46',
                                          'align': 'center', 'border': 1, 'border_color': '#A7F3D0'})
            vaz_f  = workbook.add_format({'bg_color': '#F1F5F9', 'font_color': '#CBD5E1',
                                          'align': 'center', 'border': 1, 'border_color': '#E2E8F0'})
            for i, col in enumerate(df_resumo.columns):
                ws_r.write(0, i, col, hdr_r)
                ws_r.set_column(i, i, 24)
            ws_r.freeze_panes(1, 0)
            ws_r.set_row(0, 22)
            base_start = len(df_resumo.columns) - len(base_cols_bool)
            for ri in range(1, len(df_resumo) + 1):
                for ci in range(base_start, len(df_resumo.columns)):
                    val = df_resumo.iloc[ri - 1, ci]
                    ws_r.write(ri, ci, val, sim_f if val == 'SIM' else vaz_f)

            # ── Aba 2: LegacyDB ─────────────────────────────────────────────
            df_m = df_final[df_final['cad_unico_json'].notna() & (df_final['cad_unico_json'] != '')].copy()
            _write_sheet(writer, workbook, _pick(df_m, [
                (col_cpf,                  'CPF'),
                ('nome_mec',               'Nome'),
                ('nascido_mec',            'Nascimento'),
                ('email_mec',              'E-mail'),
                ('celular_mec',            'Telefone'),
                ('endereco_mec',           'Endereço'),
                ('Resumo_Cartoes_LegacyDB', 'Cartões'),
            ]), 'LegacyDB', '#9D174D')

            # ── Aba 3: Portal Cliente ──────────────────────────────────────
            df_c = df_final[df_final['email_cliente'].notna()].copy()
            _write_sheet(writer, workbook, _pick(df_c, [
                (col_cpf,          'CPF'),
                ('email_cliente',  'E-mail'),
                ('celular_cliente','Telefone'),
            ]), 'Portal Cliente', '#1D4ED8')

            # ── Aba 4: Portal Estudante ───────────────────────────────────────
            df_e = df_final[df_final['email_estudante'].notna()].copy()
            _write_sheet(writer, workbook, _pick(df_e, [
                (col_cpf,             'CPF'),
                ('email_estudante',   'E-mail'),
                ('celular_estudante', 'Telefone'),
            ]), 'Portal Estudante', '#0E7490')

            # ── Aba 5: ABT ─────────────────────────────────────────────────
            df_a = df_final[df_final['email_abt'].notna()].copy()
            _write_sheet(writer, workbook, _pick(df_a, [
                (col_cpf,            'CPF'),
                ('nome_abt',         'Nome'),
                ('email_abt',        'E-mail'),
                ('celular_abt',      'Telefone'),
                ('bairro_abt',       'Bairro'),
                ('status_abt',       'Status'),
                ('data_cadastro_abt','Cadastro'),
            ]), 'ABT', '#4338CA')

            # ── Aba 6: Wifi Max ────────────────────────────────────────────
            df_w = df_final[df_final['email_wifi'].notna()].copy()
            _write_sheet(writer, workbook, _pick(df_w, [
                (col_cpf,      'CPF'),
                ('email_wifi', 'E-mail'),
                ('celular_wifi','Telefone'),
            ]), 'Wifi Max', '#6D28D9')

            # ── Aba 7: WhatsApp ────────────────────────────────────────────
            df_z = df_final[df_final['celular_whatsapp'].notna()].copy()
            _write_sheet(writer, workbook, _pick(df_z, [
                (col_cpf,             'CPF'),
                ('celular_whatsapp',  'Telefone WhatsApp'),
            ]), 'WhatsApp', '#15803D')

        # Save to history DB
        try:
            with engine.connect() as conn:
                conn.execute(text("""
                    INSERT INTO databridge_web.databridge_historico_massa
                    (user_id, nome_arquivo, usuario_gerou, total_cpfs)
                    VALUES (:uid, :nome, :usr, :total)
                """), {
                    "uid": user_id,
                    "nome": output_name,
                    "usr": username,
                    "total": total_p
                })
                conn.commit()
        except Exception as db_e:
            print(f"[historico] Erro ao salvar histórico: {db_e}")

        _emit(socketio, user_sid, job_id, 'finalizado', {
            'download_url': output_name,
            'stats': stats,
            'preview': preview_rows
        })

    except Exception as e:
        err = str(e)
        update_bulk_job(job_id, 0, f'Erro: {err}', status='error', error_msg=err)
        socketio.emit('status', {'msg': f'Erro: {err}', 'progress': 0}, to=user_sid)
