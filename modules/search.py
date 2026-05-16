import os
import re
import json
import time
import datetime
import requests
from flask import Blueprint, request, jsonify, session
from sqlalchemy import bindparam, text
from core.config import CARD_USAGE_API_KEY, CARD_USAGE_API_URL, UPLOAD_FOLDER
from core.database import engine, safe_json_parse
from modules.auth import login_required, permission_required
from modules.contact_fallbacks import delivery_fallback_query

search_bp = Blueprint('search', __name__)
_card_sale_origin_cache = {}
_CARD_SALE_ORIGIN_CACHE_TTL = 300


def parse_card_usage_datetime(value):
    try:
        return datetime.datetime.strptime(str(value or ''), '%d/%m/%Y %H:%M:%S')
    except Exception:
        return datetime.datetime.min


def parse_local_card_datetime(value):
    if not value:
        return None
    for fmt in ('%Y-%m-%d %H:%M:%S', '%d/%m/%Y %H:%M:%S'):
        try:
            return datetime.datetime.strptime(str(value), fmt)
        except Exception:
            continue
    return None


def parse_card_number_parts(card):
    match = re.match(r'^(\d{2})\.(\d{2})\.(\d+)-\d$', str(card or '').strip())
    if not match:
        return None
    return {
        'iss_id': int(match.group(1)),
        'cd_id': int(match.group(2)),
        'crd_snr': int(match.group(3)),
    }


def _enrich_from_cardaccount(card_parts, unmatched_rows, max_dt):
    """Fallback: identifica transferências de crédito (CAC_KEY1=99999) via Oracle CARDACCOUNT."""
    if not unmatched_rows:
        return
    try:
        from modules.dashboard import get_quota_connection
        oracle = get_quota_connection()
    except Exception as exc:
        print(f"[CARD_USAGE] Oracle indisponivel para fallback CARDACCOUNT: {exc}")
        return

    try:
        cursor = oracle.cursor()
        cursor.execute("""
            SELECT c.CAC_SEQNBR, c.CAC_TRANDATE, c.CAC_TRANVALUE, c.CAC_KEY1, c.CAC_STATUS,
                   c.CAC_EFECTDATE
            FROM CARDACCOUNT c
            WHERE c.ISS_ID = :iss_id
              AND c.CD_ID  = :cd_id
              AND c.CRD_SNR = :crd_snr
              AND c.CAC_TYPE = 'C'
              AND c.CAC_STATUS = 'C'
              AND COALESCE(c.CAC_EFECTDATE, c.CAC_TRANDATE) <= :max_dt
              AND (
                  c.CAC_KEY1 = 99999
                  OR EXISTS (
                      SELECT 1 FROM CARDACCOUNT d
                      WHERE d.USR_ID = c.USR_ID
                        AND d.APP_ID = c.APP_ID
                        AND d.CAC_TRANDATE = c.CAC_TRANDATE
                        AND d.CAC_TRANVALUE = c.CAC_TRANVALUE
                        AND d.CAC_TYPE = 'D'
                        AND (d.CI_ID <> c.CI_ID OR d.CRD_SNR <> c.CRD_SNR)
                  )
              )
            ORDER BY COALESCE(c.CAC_EFECTDATE, c.CAC_TRANDATE) DESC
        """, {
            'iss_id':  card_parts['iss_id'],
            'cd_id':   card_parts['cd_id'],
            'crd_snr': card_parts['crd_snr'],
            'max_dt':  max_dt,
        })
        cols = [d[0] for d in cursor.description]
        ca_rows = [dict(zip(cols, row)) for row in cursor.fetchall()]
    except Exception as exc:
        print(f"[CARD_USAGE] Falha ao consultar CARDACCOUNT: {exc}")
        return
    finally:
        try:
            oracle.close()
        except Exception:
            pass

    normalized = []
    for r in ca_rows:
        # Usar CAC_EFECTDATE (data efetiva no cartão) quando disponível; fallback para CAC_TRANDATE.
        raw_dt = r.get('CAC_EFECTDATE') or r.get('CAC_TRANDATE')
        if not isinstance(raw_dt, datetime.datetime):
            continue
        try:
            value_cents = int(r['CAC_TRANVALUE'])
        except Exception:
            continue
        normalized.append({
            'dt': raw_dt,
            'cents': value_cents,
        })

    used = set()
    for row_index, item, recharge_dt in sorted(unmatched_rows, key=lambda r: r[2]):
        expected = int(round(float(item.get('value') or 0) * 100))
        candidates = []
        for i, ca in enumerate(normalized):
            if i in used or ca['cents'] != expected:
                continue
            delta = (recharge_dt - ca['dt']).total_seconds()
            if -3600 <= delta <= 90 * 24 * 3600:
                candidates.append((abs(delta), i, ca))
        if not candidates:
            continue
        _, best_i, best = min(candidates, key=lambda c: c[0])
        used.add(best_i)
        item['saleOrigin'] = 'Transferência de Crédito'
        item['saleType'] = ''
        item['saleRevenueType'] = ''
        item['saleDatetime'] = best['dt'].strftime('%d/%m/%Y %H:%M:%S')


def enrich_recharge_sale_origin(card, usage):
    """Attach sale origin details to recharge/purchase rows using COM_NETSALES."""
    if not usage:
        return usage

    card_parts = parse_card_number_parts(card)
    if not card_parts:
        return usage

    recharge_rows = []
    for index, item in enumerate(usage):
        if str(item.get('tranType') or '').upper() not in ('RECARGA', 'COMPRA', 'RECARGA PENDENTE'):
            continue
        recharge_dt = parse_card_usage_datetime(item.get('datetime'))
        if recharge_dt == datetime.datetime.min:
            continue
        recharge_rows.append((index, item, recharge_dt))

    if not recharge_rows:
        return usage

    cache_key = (
        card,
        tuple(sorted(
            build_sale_origin_key(item)
            for _, item, _ in recharge_rows
        ))
    )
    cached = _card_sale_origin_cache.get(cache_key)
    if cached and (time.time() - cached.get('cached_at', 0)) < _CARD_SALE_ORIGIN_CACHE_TTL:
        origins = cached.get('origins') or {}
        for _, item, _ in recharge_rows:
            origin = origins.get(build_sale_origin_key(item))
            if origin:
                item.update(origin)
        return usage

    sale_values = sorted({
        str(int(round(float(item.get('value') or 0) * 100)))
        for _, item, _ in recharge_rows
        if float(item.get('value') or 0) > 0
    })
    if not sale_values:
        return usage

    min_dt = min(row[2] for row in recharge_rows) - datetime.timedelta(days=90)
    max_dt = max(row[2] for row in recharge_rows) + datetime.timedelta(days=1)

    try:
        with engine.connect() as conn:
            sales_sql = text("""
                SELECT TIPO_VENDA, PONTO_VENDA, VALOR, DATA, RECIBO, TIPO_RECEITA
                FROM sntr_interligar.COM_NETSALES
                WHERE ISS_ID = :iss_id
                  AND CD_ID = :cd_id
                  AND CRD_SNR = :crd_snr
                  AND VALOR IN :sale_values
                  AND DATA BETWEEN :min_dt AND :max_dt
                ORDER BY DATA DESC
            """).bindparams(bindparam('sale_values', expanding=True))
            sales = conn.execute(sales_sql, {
                **card_parts,
                'sale_values': sale_values,
                'min_dt': min_dt,
                'max_dt': max_dt,
            }).mappings().fetchall()
    except Exception as exc:
        print(f"[CARD_USAGE] Falha ao cruzar origem da venda do cartao {card}: {exc}")
        return usage

    normalized_sales = []
    for sale in sales:
        try:
            sale_value = int(round(float(str(sale.get('VALOR') or '0').replace(',', '.'))))
        except Exception:
            sale_value = None
        sale_dt = sale.get('DATA')
        if not isinstance(sale_dt, datetime.datetime):
            sale_dt = parse_local_card_datetime(sale_dt)
        if sale_dt and sale_value is not None:
            normalized_sales.append({**dict(sale), 'sale_value_cents': sale_value, 'sale_dt': sale_dt})

    used_sale_indexes = set()
    for row_index, item, recharge_dt in sorted(recharge_rows, key=lambda row: row[2]):
        expected_cents = int(round(float(item.get('value') or 0) * 100))
        candidates = []
        for sale_index, sale in enumerate(normalized_sales):
            if sale_index in used_sale_indexes:
                continue
            if sale['sale_value_cents'] != expected_cents:
                continue
            # Sale happens before validation; allow up to 90 days of delay.
            delta_seconds = (recharge_dt - sale['sale_dt']).total_seconds()
            if -3600 <= delta_seconds <= 90 * 24 * 3600:
                candidates.append((abs(delta_seconds), sale_index, sale))

        if not candidates:
            continue

        _, sale_index, sale = min(candidates, key=lambda candidate: candidate[0])
        used_sale_indexes.add(sale_index)
        item['saleOrigin'] = normalize_sale_origin(sale.get('PONTO_VENDA'))
        item['saleType'] = sale.get('TIPO_VENDA') or ''
        item['saleRevenueType'] = sale.get('TIPO_RECEITA') or ''
        item['saleReceipt'] = sale.get('RECIBO')
        item['saleDatetime'] = sale['sale_dt'].strftime('%d/%m/%Y %H:%M:%S')

    # Pass 3: Oracle CARDACCOUNT fallback — também reavalia entradas Mercury que podem ser transferências.
    still_unmatched = [
        (ri, item, rdt)
        for ri, item, rdt in recharge_rows
        if (not item.get('saleOrigin') or item.get('saleOrigin') == 'Mercury')
        and not item.get('saleType') and not item.get('saleDatetime')
    ]
    if still_unmatched:
        _enrich_from_cardaccount(card_parts, still_unmatched, max_dt)

    _card_sale_origin_cache[cache_key] = {
        'cached_at': time.time(),
        'origins': {
            build_sale_origin_key(item): {
                'saleOrigin': item.get('saleOrigin') or '',
                'saleType': item.get('saleType') or '',
                'saleRevenueType': item.get('saleRevenueType') or '',
                'saleReceipt': item.get('saleReceipt'),
                'saleDatetime': item.get('saleDatetime') or '',
            }
            for _, item, _ in recharge_rows
            if item.get('saleOrigin') or item.get('saleType') or item.get('saleDatetime')
        }
    }
    if len(_card_sale_origin_cache) > 500:
        expired_before = time.time() - _CARD_SALE_ORIGIN_CACHE_TTL
        for key, value in list(_card_sale_origin_cache.items()):
            if value.get('cached_at', 0) < expired_before:
                _card_sale_origin_cache.pop(key, None)

    return usage


def build_sale_origin_key(item):
    return '|'.join([
        str(item.get('datetime') or ''),
        f"{float(item.get('value') or 0):.2f}",
        str(item.get('tranSequence') or ''),
    ])


def normalize_sale_origin(value):
    raw = str(value or '').strip()
    if raw == '23':
        return 'LOJA ABT'
    return raw


def get_local_card_usage_fallback(card, start_date, end_date):
    json_path = '$.' + json.dumps(card)
    start_dt = datetime.datetime.combine(start_date, datetime.time.min)
    end_dt = datetime.datetime.combine(end_date + datetime.timedelta(days=1), datetime.time.min)
    rows = []

    try:
        with engine.connect() as conn:
            row = conn.execute(text("""
                SELECT cartoes_json
                FROM sntr_interligar.SALES_CAD_UNICO_JSON
                WHERE JSON_CONTAINS_PATH(cartoes_json, 'one', :json_path)
                LIMIT 1
            """), {'json_path': json_path}).mappings().fetchone()
    except Exception as exc:
        print(f"[CARD_USAGE] Falha ao consultar fallback local do cartao {card}: {exc}")
        return []

    if not row or not row.get('cartoes_json'):
        return []

    parsed = safe_json_parse(row['cartoes_json'])
    card_data = parsed.get(card) if isinstance(parsed, dict) else None
    if not isinstance(card_data, dict):
        return []

    for card_type, apps in card_data.items():
        if not isinstance(apps, dict):
            continue
        for app_id, details in apps.items():
            if not isinstance(details, dict):
                continue

            usage_dt = parse_local_card_datetime(details.get('ultimo_uso'))
            if usage_dt and start_dt <= usage_dt < end_dt:
                rows.append({
                    'datetime': usage_dt.strftime('%d/%m/%Y %H:%M:%S'),
                    'value': 0,
                    'lineCode': '-',
                    'lineDesc': 'Registro local Mercury',
                    'appDesc': f"{card_type} / App {app_id}",
                    'tranType': 'USO',
                    'purse': details.get('saldo') or 0,
                    'tranSequence': '-',
                    'localFallback': True,
                })

            recharge_dt = parse_local_card_datetime(details.get('ultima_recarga'))
            if recharge_dt and start_dt <= recharge_dt < end_dt:
                rows.append({
                    'datetime': recharge_dt.strftime('%d/%m/%Y %H:%M:%S'),
                    'value': details.get('valor_ultima_recarga') or 0,
                    'lineCode': '-',
                    'lineDesc': 'Registro local Mercury',
                    'appDesc': f"{card_type} / App {app_id}",
                    'tranType': 'RECARGA',
                    'purse': details.get('saldo') or 0,
                    'tranSequence': '-',
                    'localFallback': True,
                })

            pending_recharge_dt = parse_local_card_datetime(details.get('recarga_pendente'))
            if pending_recharge_dt and start_dt <= pending_recharge_dt < end_dt:
                rows.append({
                    'datetime': pending_recharge_dt.strftime('%d/%m/%Y %H:%M:%S'),
                    'value': details.get('valor_recarga_pendente') or 0,
                    'lineCode': '-',
                    'lineDesc': 'Recarga pendente no Mercury.',
                    'appDesc': f"{card_type} / App {app_id}",
                    'tranType': 'RECARGA PENDENTE',
                    'purse': details.get('saldo') or 0,
                    'tranSequence': 'Pendente',
                    'localFallback': True,
                    'localPendingRecharge': True,
                })

    return sorted(rows, key=lambda item: parse_card_usage_datetime(item.get('datetime')), reverse=True)


def merge_local_effective_recharges(card, usage, start_date, end_date):
    """Add effective local Mercury recharges that are missing from the API usage list."""
    local_rows = get_local_card_usage_fallback(card, start_date, end_date)
    if not local_rows:
        return usage, False

    existing_recharges = set()
    for item in usage:
        item_dt = parse_card_usage_datetime(item.get('datetime'))
        value_cents = int(round(float(item.get('value') or 0) * 100))
        tran_type = str(item.get('tranType') or '').upper()
        if tran_type in ('RECARGA', 'COMPRA') or value_cents > 0:
            existing_recharges.add((
                item_dt.date() if item_dt != datetime.datetime.min else None,
                value_cents,
            ))

    added = False
    for local in local_rows:
        if str(local.get('tranType') or '').upper() != 'RECARGA':
            continue
        local_dt = parse_card_usage_datetime(local.get('datetime'))
        value_cents = int(round(float(local.get('value') or 0) * 100))
        key = (local_dt.date() if local_dt != datetime.datetime.min else None, value_cents)
        if key in existing_recharges:
            continue
        local['tranType'] = 'RECARGA'
        local['saleOrigin'] = 'Mercury'
        local['lineCode'] = 'MERCURY'
        local['lineDesc'] = 'Recarga efetivada no Mercury.'
        local['localEffectiveRecharge'] = True
        local['tranSequence'] = local.get('tranSequence') or 'Local'
        usage.append(local)
        existing_recharges.add(key)
        added = True

    return usage, added


def merge_local_pending_recharges(card, usage, start_date, end_date):
    """Add local Mercury pending recharges that are missing from the API usage list."""
    local_rows = get_local_card_usage_fallback(card, start_date, end_date)
    if not local_rows:
        return usage, False

    existing_positive = {}
    for item in usage:
        item_dt = parse_card_usage_datetime(item.get('datetime'))
        value_cents = int(round(float(item.get('value') or 0) * 100))
        tran_type = str(item.get('tranType') or '').upper()
        if tran_type in ('RECARGA', 'COMPRA', 'RECARGA PENDENTE') or value_cents > 0:
            existing_positive[(
                item_dt.date() if item_dt != datetime.datetime.min else None,
                value_cents,
            )] = item

    added = False
    for local in local_rows:
        if str(local.get('tranType') or '').upper() != 'RECARGA PENDENTE':
            continue
        local_dt = parse_card_usage_datetime(local.get('datetime'))
        value_cents = int(round(float(local.get('value') or 0) * 100))
        key = (local_dt.date() if local_dt != datetime.datetime.min else None, value_cents)
        if key in existing_positive:
            item = existing_positive[key]
            item['tranType'] = 'RECARGA PENDENTE'
            item['lineCode'] = '-'
            item['lineDesc'] = 'Recarga pendente no Mercury.'
            item['appDesc'] = local.get('appDesc') or item.get('appDesc')
            item['tranSequence'] = local.get('tranSequence') or 'Pendente'
            item['localPendingRecharge'] = True
            for sale_key in ('saleOrigin', 'saleType', 'saleRevenueType', 'saleReceipt', 'saleDatetime'):
                item.pop(sale_key, None)
            added = True
            continue
        usage.append(local)
        existing_positive[key] = local
        added = True

    return usage, added


def merge_cardaccount_missing_recharges(card, usage, start_date, end_date):
    """Inject CARDACCOUNT credit entries not returned by the API:
    1. Transfers (CAC_KEY1=99999) authorized within the period.
    2. Any credit effected within the period but authorized before it (delayed recharges).
    """
    card_parts = parse_card_number_parts(card)
    if not card_parts:
        return usage, False

    try:
        from modules.dashboard import get_quota_connection
        oracle = get_quota_connection()
    except Exception as exc:
        print(f"[CARD_USAGE] Oracle indisponivel para merge CARDACCOUNT: {exc}")
        return usage, False

    min_dt = datetime.datetime.combine(start_date, datetime.time.min)
    max_dt = datetime.datetime.combine(end_date + datetime.timedelta(days=1), datetime.time.min)
    base_params = {
        'iss_id':  card_parts['iss_id'],
        'cd_id':   card_parts['cd_id'],
        'crd_snr': card_parts['crd_snr'],
        'min_dt':  min_dt,
        'max_dt':  max_dt,
    }

    ca_entries = []
    delayed_entries = []
    try:
        cursor = oracle.cursor()
        # Query 1: transfers authorized within the display period.
        cursor.execute("""
            SELECT CAC_SEQNBR, CAC_TRANDATE, NULL AS CAC_EFECTDATE, CAC_TRANVALUE, CAC_KEY1, APP_ID
            FROM CARDACCOUNT
            WHERE ISS_ID  = :iss_id
              AND CD_ID   = :cd_id
              AND CRD_SNR = :crd_snr
              AND CAC_TYPE = 'C'
              AND CAC_STATUS = 'C'
              AND CAC_KEY1 = 99999
              AND CAC_TRANDATE >= :min_dt
              AND CAC_TRANDATE <  :max_dt
            ORDER BY CAC_TRANDATE DESC
        """, base_params)
        cols = [d[0] for d in cursor.description]
        ca_entries = [dict(zip(cols, row)) for row in cursor.fetchall()]

        # Query 2: any credit effected in-period but authorized before/after the period.
        # These are delayed recharges the API omits because it filters by authorization date.
        cursor.execute("""
            SELECT CAC_SEQNBR, CAC_TRANDATE, CAC_EFECTDATE, CAC_TRANVALUE, CAC_KEY1, APP_ID
            FROM CARDACCOUNT
            WHERE ISS_ID  = :iss_id
              AND CD_ID   = :cd_id
              AND CRD_SNR = :crd_snr
              AND CAC_TYPE = 'C'
              AND CAC_STATUS = 'C'
              AND CAC_EFECTDATE >= :min_dt
              AND CAC_EFECTDATE <  :max_dt
              AND (CAC_TRANDATE < :min_dt OR CAC_TRANDATE >= :max_dt)
            ORDER BY CAC_EFECTDATE DESC
        """, base_params)
        cols2 = [d[0] for d in cursor.description]
        delayed_entries = [dict(zip(cols2, row)) for row in cursor.fetchall()]
    except Exception as exc:
        print(f"[CARD_USAGE] Falha ao consultar CARDACCOUNT para merge: {exc}")
        return usage, False
    finally:
        try:
            oracle.close()
        except Exception:
            pass

    if not ca_entries and not delayed_entries:
        return usage, False

    # Existing credit entries for tolerance-based dedup (Query 1).
    existing_credits = []
    for item in usage:
        if str(item.get('tranType') or '').upper() not in (
                'RECARGA', 'COMPRA', 'RECARGA PENDENTE', 'TRANSFERÊNCIA DE CRÉDITO'):
            continue
        item_dt = parse_card_usage_datetime(item.get('datetime'))
        v = int(round(float(item.get('value') or 0) * 100))
        if item_dt != datetime.datetime.min:
            existing_credits.append((v, item_dt.date()))

    # Existing sequence numbers for exact dedup (Query 2).
    existing_seqs = set()
    for item in usage:
        seq = str(item.get('tranSequence') or '').strip()
        if seq and seq not in ('-', 'Pendente', 'Local'):
            try:
                existing_seqs.add(int(seq))
            except ValueError:
                pass

    added = False

    # Inject Query 1 results (transfers within period).
    for ca in ca_entries:
        raw_dt = ca.get('CAC_TRANDATE')
        if not isinstance(raw_dt, datetime.datetime):
            continue
        try:
            value_cents = int(ca['CAC_TRANVALUE'])
        except Exception:
            continue
        ca_date = raw_dt.date()
        if any(v == value_cents and abs((ca_date - d).days) <= 45
               for v, d in existing_credits):
            continue
        valor_reais = value_cents / 100.0
        usage.append({
            'datetime':        raw_dt.strftime('%d/%m/%Y %H:%M:%S'),
            'value':           valor_reais,
            'lineCode':        '-',
            'lineDesc':        'Registro via CARDACCOUNT.',
            'appDesc':         'ESCOLAR / App 910',
            'tranType':        'RECARGA',
            'purse':           0,
            'tranSequence':    str(ca.get('CAC_SEQNBR') or '-'),
            'saleOrigin':      'Transferência de Crédito',
            'saleType':        '',
            'saleRevenueType': '',
            'saleDatetime':    raw_dt.strftime('%d/%m/%Y %H:%M:%S'),
        })
        existing_credits.append((value_cents, ca_date))
        seqnbr = ca.get('CAC_SEQNBR')
        if seqnbr:
            existing_seqs.add(int(seqnbr))
        added = True

    # Inject Query 2 results (delayed recharges effected in-period).
    for ca in delayed_entries:
        seqnbr = ca.get('CAC_SEQNBR')
        if seqnbr and int(seqnbr) in existing_seqs:
            continue
        raw_dt = ca.get('CAC_EFECTDATE') or ca.get('CAC_TRANDATE')
        if not isinstance(raw_dt, datetime.datetime):
            continue
        try:
            value_cents = int(ca['CAC_TRANVALUE'])
        except Exception:
            continue
        # Skip if Mercury/API already recorded same value on same day (same physical event).
        ca_date = raw_dt.date()
        if any(v == value_cents and abs((ca_date - d).days) <= 1
               for v, d in existing_credits):
            continue
        origin = 'Transferência de Crédito' if ca.get('CAC_KEY1') == 99999 else ''
        valor_reais = value_cents / 100.0
        usage.append({
            'datetime':        raw_dt.strftime('%d/%m/%Y %H:%M:%S'),
            'value':           valor_reais,
            'lineCode':        '-',
            'lineDesc':        'Recarga efetivada com atraso (CARDACCOUNT).',
            'appDesc':         f"App {ca.get('APP_ID') or '-'}",
            'tranType':        'RECARGA',
            'purse':           0,
            'tranSequence':    str(seqnbr or '-'),
            'saleOrigin':      origin,
            'saleType':        '',
            'saleRevenueType': '',
            'saleDatetime':    raw_dt.strftime('%d/%m/%Y %H:%M:%S'),
        })
        if seqnbr:
            existing_seqs.add(int(seqnbr))
        added = True

    return usage, added


@search_bp.route('/api/search_cpf', methods=['POST'])
@login_required
@permission_required('analise')
def search_cpf():
    data = request.json
    raw_cpf = str(data.get('cpf', '')).strip()

    if not raw_cpf:
        return jsonify({'error': 'CPF ou Cartão não fornecido.'}), 400

    # REVERSE SEARCH LOGIC
    # Se o input parece um numero de cartao (ex: 58.13.06000028-8)
    if re.match(r'^\d{2}\.\d{2}\.\d+-\d$', raw_cpf):
        try:
            with engine.connect() as conn:
                q_rev = text("SELECT cpf FROM sntr_interligar.SALES_CAD_UNICO_JSON WHERE cartoes_json LIKE :card LIMIT 1")
                found_cpf = conn.execute(q_rev, {"card": f"%{raw_cpf}%"}).scalar()
                if not found_cpf:
                    return jsonify({'error': 'Nenhum CPF associado a este cartão na base Mercury.'}), 404
                raw_cpf = str(found_cpf)
        except Exception as e:
            return jsonify({'error': f'Erro na busca reversa: {str(e)}'}), 500

    cpf_limpo = re.sub(r'\D', '', raw_cpf)
    cpf_formatted = f"{cpf_limpo[:3]}.{cpf_limpo[3:6]}.{cpf_limpo[6:9]}-{cpf_limpo[9:]}" if len(cpf_limpo) == 11 else raw_cpf

    result = {
        'cpf': raw_cpf,
        'sntr_cliente': None,
        'databridge_db_alunos': None,
        'abt_data': None,
        'wifi_users': None,
        'whatsapp': None,
        'cad_unico': None,
        'requisicoes_estudante': []
    }
    
    try:
        with engine.connect() as conn:
            delivery_row = conn.execute(
                delivery_fallback_query("u.cpf IN (:cpf_limpo, :cpf_formatted)"),
                {"cpf_limpo": cpf_limpo, "cpf_formatted": cpf_formatted}
            ).fetchone()

            # 1. sntr_cliente.customer
            q1 = text("""
                SELECT 
                    c.name,
                    c.cellphone, 
                    c.email, 
                    GROUP_CONCAT(DISTINCT CONCAT_WS(', ', a.street, a.number, a.district, a.zip_code) SEPARATOR ' | ') AS endereco
                FROM 
                    sntr_cliente.customer c 
                LEFT JOIN 
                    sntr_cliente.address a ON a.id_customer = c.id
                WHERE c.cpf IN (:cpf_limpo, :cpf_formatted)
                GROUP BY 
                    c.id
                LIMIT 1
            """)
            row1 = conn.execute(q1, {"cpf_limpo": cpf_limpo, "cpf_formatted": cpf_formatted}).fetchone()
            if row1:
                celular_cliente = row1[1]
                endereco_cliente = row1[3]
                if delivery_row:
                    if delivery_row[2]:
                        celular_cliente = delivery_row[2]
                    if not endereco_cliente and delivery_row[3]:
                        endereco_cliente = delivery_row[3]
                result['sntr_cliente'] = {
                    'nome': row1[0],
                    'celular': celular_cliente or '',
                    'email': row1[2],
                    'endereco': endereco_cliente or ''
                }

            # 2. databridge_db.alunos
            q2 = text("""
                SELECT 
                    nome,
                    celular, 
                    email, 
                    GROUP_CONCAT(
                        DISTINCT CONCAT_WS(', ', logradouro, numero, complemento, bairro, endereco, cep) 
                        SEPARATOR ' | '
                    ) AS todos_enderecos
                FROM 
                    databridge_db.alunos
                WHERE cpf = :cpf
                GROUP BY 
                    nome,
                    celular, 
                    email
                LIMIT 1
            """)
            row2 = conn.execute(q2, {"cpf": cpf_limpo}).fetchone()
            if row2: result['databridge_db_alunos'] = {'nome': row2[0], 'celular': row2[1], 'email': row2[2], 'endereco': row2[3]}

            # 3. sntr_interligar.COM_CLIENTES_ABT
            q3 = text("""
                SELECT 
                    nome, email, celular, bairro, status, data_cadastro
                FROM sntr_interligar.COM_CLIENTES_ABT
                WHERE documento IN (:cpf_limpo, :cpf_formatted)
                ORDER BY data_cadastro DESC
                LIMIT 1
            """)
            row3 = conn.execute(q3, {"cpf_limpo": cpf_limpo, "cpf_formatted": cpf_formatted}).fetchone()
            if row3: 
                result['abt_data'] = {
                    'nome': row3[0], 
                    'email': row3[1], 
                    'celular': row3[2], 
                    'endereco': row3[3], 
                    'status': row3[4],
                    'data_cadastro': str(row3[5]) if row3[5] else None
                }
            # 4. sntr_interligar.WIFIMAX_USERS
            q4 = text("SELECT MAX(EMAIL) as email, MAX(TELEFONE) as celular FROM sntr_interligar.WIFIMAX_USERS WHERE CPF = :cpf GROUP BY CPF")
            row4 = conn.execute(q4, {"cpf": cpf_limpo}).fetchone()
            if row4: result['wifi_users'] = {'email': row4[0], 'celular': row4[1]}

            # 5. sntr_interligar.CLIENTES_WHATSAPP
            q5 = text("SELECT telefone FROM sntr_interligar.CLIENTES_WHATSAPP WHERE cpf = :cpf LIMIT 1")
            row5 = conn.execute(q5, {"cpf": cpf_limpo}).fetchone()
            if row5: result['whatsapp'] = {'telefone': row5[0]}
            
            # 6. sntr_interligar.SALES_CAD_UNICO_JSON
            q6 = text("SELECT * FROM sntr_interligar.SALES_CAD_UNICO_JSON WHERE cpf = :cpf LIMIT 1")
            row6 = conn.execute(q6, {"cpf": cpf_limpo}).mappings().fetchone()
            if row6:
                cad_data = dict(row6)
                if 'cartoes_json' in cad_data and cad_data['cartoes_json']:
                    cad_data['json_parsed'] = safe_json_parse(cad_data['cartoes_json'])
                result['cad_unico'] = cad_data

            # 7. databridge_db.vw_alunos_aprovados (Requisições Sou Estudante)
            q7 = text("""
                SELECT
                    nome_curso,
                    nome_escola,
                    tipo_instituicao,
                    status,
                    modalidade,
                    data_inicio,
                    data_termino,
                    data_requisicao 
                FROM databridge_db.vw_alunos_aprovados
                WHERE cpf IN (:cpf_limpo, :cpf_formatted)
                ORDER BY CASE WHEN status = 'Aprovado' THEN 0 ELSE 1 END, data_requisicao DESC
            """)
            rows7 = conn.execute(q7, {"cpf_limpo": cpf_limpo, "cpf_formatted": cpf_formatted}).fetchall()
            reqs = []
            for r in rows7:
                reqs.append({
                    'nome_curso': r[0],
                    'nome_escola': r[1],
                    'tipo_instituicao': r[2],
                    'status': r[3],
                    'modalidade': r[4],
                    'data_inicio': str(r[5]) if r[5] else None,
                    'data_termino': str(r[6]) if r[6] else None,
                    'data_requisicao': str(r[7]) if r[7] else None
                })
            result['requisicoes_estudante'] = reqs

        return jsonify(result), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@search_bp.route('/api/card_usage', methods=['GET'])
@login_required
@permission_required('analise')
def get_card_usage():
    card = str(request.args.get('card') or '').strip()
    if not re.match(r'^\d{2}\.\d{2}\.\d+-\d$', card):
        return jsonify({'error': 'Cartao invalido.'}), 400

    today = datetime.date.today()
    start_date = today - datetime.timedelta(days=30)

    def local_fallback_response(note, source='local_fallback', status_code=200, result=True):
        fallback_usage = get_local_card_usage_fallback(card, start_date, today)
        response_note = note
        if not fallback_usage and source == 'local_fallback_api_error':
            response_note = 'A API oficial oscilou e nao ha movimento local recente para exibir agora. Tente novamente em instantes.'
        return jsonify({
            'result': result,
            'source': source,
            'note': response_note,
            'data': {
                'cardNumber': card,
                'usage': fallback_usage,
            },
            'data_ini': start_date.strftime('%d/%m/%Y'),
            'data_fim': today.strftime('%d/%m/%Y'),
        }), status_code

    try:
        response = requests.get(
            CARD_USAGE_API_URL,
            params={
                'key': CARD_USAGE_API_KEY,
                'card': card,
                'data_ini': start_date.strftime('%d/%m/%Y'),
                'data_fim': today.strftime('%d/%m/%Y'),
            },
            timeout=(5, 20)
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        print(f"[CARD_USAGE] Falha ao consultar usos do cartao {card}: {exc}")
        return local_fallback_response(
            'A API oficial oscilou; exibindo o ultimo movimento registrado na base Mercury.',
            source='local_fallback_api_error',
        )

    if not payload.get('result'):
        fallback_usage = get_local_card_usage_fallback(card, start_date, today)
        if fallback_usage:
            return local_fallback_response(
                'A API oficial nao retornou o detalhamento; exibindo o ultimo movimento registrado na base Mercury.'
            )
        return jsonify({
            'result': False,
            'data': {
                'cardNumber': card,
                'usage': [],
            },
            'data_ini': start_date.strftime('%d/%m/%Y'),
            'data_fim': today.strftime('%d/%m/%Y'),
        }), 200

    data = payload.get('data') or {}
    usage = data.get('usage') or []
    if not isinstance(usage, list):
        usage = []

    if request.args.get('include_sale_origin') == '1':
        usage = enrich_recharge_sale_origin(card, usage)
    usage, added_local_recharges = merge_local_effective_recharges(card, usage, start_date, today)
    usage, added_pending_recharges = merge_local_pending_recharges(card, usage, start_date, today)
    usage, added_ca_recharges = merge_cardaccount_missing_recharges(card, usage, start_date, today)
    usage = sorted(usage, key=lambda item: parse_card_usage_datetime(item.get('datetime')), reverse=True)
    source = 'api'
    notes = []
    if added_local_recharges:
        notes.append('Inclui recarga(s) efetivadas no Mercury que nao aparecem na API de movimentacao do cartao.')
    if added_pending_recharges:
        notes.append('Inclui recarga(s) pendente(s) registradas no Mercury.')
    note = ' '.join(notes) if notes else None
    if not usage:
        usage = get_local_card_usage_fallback(card, start_date, today)
        if usage:
            source = 'local_fallback'
            note = 'A API oficial nao retornou o detalhamento; exibindo o ultimo movimento registrado na base Mercury.'

    return jsonify({
        'result': True,
        'source': source,
        'note': note,
        'data': {
            'cardNumber': data.get('cardNumber') or card,
            'usage': usage,
        },
        'data_ini': start_date.strftime('%d/%m/%Y'),
        'data_fim': today.strftime('%d/%m/%Y'),
    }), 200


@search_bp.route('/api/card_usage_sale_origins', methods=['POST'])
@login_required
@permission_required('analise')
def get_card_usage_sale_origins():
    data = request.json or {}
    card = str(data.get('card') or '').strip()
    if not re.match(r'^\d{2}\.\d{2}\.\d+-\d$', card):
        return jsonify({'error': 'Cartao invalido.'}), 400

    raw_recharges = data.get('recharges') or []
    if not isinstance(raw_recharges, list):
        raw_recharges = []

    usage = []
    for item in raw_recharges[:50]:
        usage.append({
            'datetime': item.get('datetime'),
            'value': item.get('value'),
            'tranSequence': item.get('tranSequence'),
            'tranType': 'RECARGA',
        })

    enriched = enrich_recharge_sale_origin(card, usage)
    origins = {}
    for item in enriched:
        if not (item.get('saleOrigin') or item.get('saleType') or item.get('saleDatetime')):
            continue
        origins[build_sale_origin_key(item)] = {
            'saleOrigin': item.get('saleOrigin') or '',
            'saleType': item.get('saleType') or '',
            'saleRevenueType': item.get('saleRevenueType') or '',
            'saleReceipt': item.get('saleReceipt'),
            'saleDatetime': item.get('saleDatetime') or '',
        }

    return jsonify({'ok': True, 'origins': origins}), 200


@search_bp.route('/api/historico_massa', methods=['GET'])
@login_required
@permission_required('cruzamento')
def get_historico_massa():
    user_id = session.get('user_id')
    try:
        with engine.connect() as conn:
            # Fetch top 10 most recent generated files for THIS user only
            query = text('''
                SELECT id, nome_arquivo, data_geracao, usuario_gerou, total_cpfs 
                FROM databridge_web.databridge_historico_massa 
                WHERE user_id = :uid
                ORDER BY data_geracao DESC 
                LIMIT 10
            ''')
            rows = conn.execute(query, {'uid': user_id}).mappings().fetchall()
            
            # Format datetime for JSON response
            result = []
            folder = UPLOAD_FOLDER
            
            for r in rows:
                row_dict = dict(r)
                
                # Check if file still exists on disk, otherwise skip it (was cleaned up)
                file_path = os.path.join(folder, row_dict['nome_arquivo'])
                if not os.path.exists(file_path):
                    continue
                    
                if isinstance(row_dict['data_geracao'], datetime.datetime):
                    row_dict['data_geracao'] = row_dict['data_geracao'].strftime('%d/%m/%Y %H:%M:%S')
                result.append(row_dict)
                
            return jsonify(result), 200
    except Exception as e:
        print(f"[API Historico] Erro: {e}")
        return jsonify({'error': str(e)}), 500
