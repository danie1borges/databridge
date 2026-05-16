import re
import json
import pandas as pd
import urllib.parse
from sqlalchemy import create_engine, text
from core.config import MYSQL_CONFIG

def get_mysql_engine():
    senha = urllib.parse.quote_plus(MYSQL_CONFIG['password'])
    url = f"mysql+mysqlconnector://{MYSQL_CONFIG['user']}:{senha}@{MYSQL_CONFIG['host']}/{MYSQL_CONFIG['database']}"
    return create_engine(url, pool_size=30, max_overflow=20, pool_pre_ping=True, pool_recycle=3600)

# Global engine — reuse across all requests (connection pooling)
engine = get_mysql_engine()

def get_db_connection():
    """Returns the global engine for connections."""
    return engine

def clean_cpf(cpf):
    """Remove máscara de CPF. Corrige zero à esquerda perdido pelo Excel (10 → 11 dígitos)."""
    if pd.isna(cpf) or str(cpf).strip() == '':
        return None
    digits = re.sub(r'\D', '', str(cpf))
    if not digits:
        return None
    if len(digits) == 10:
        digits = '0' + digits
    return digits

def safe_json_parse(json_str):
    """Tenta dar parse em JSON com graceful fallback."""
    if pd.isna(json_str) or not json_str:
        return {}
    if isinstance(json_str, dict):
        return json_str
    try:
        return json.loads(json_str)
    except:
        return {}
