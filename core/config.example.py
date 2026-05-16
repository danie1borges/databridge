import os
import secrets

# Copie este arquivo para core/config.py em cada ambiente.
# O core/config.py real fica fora do Git para nao sobrescrever producao.

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')

SECRET_KEY = os.getenv('DATACROSS_SECRET_KEY') or secrets.token_hex(32)

MYSQL_CONFIG = {
    'host': os.getenv('DATACROSS_MYSQL_HOST', 'SEU_HOST_MYSQL'),
    'user': os.getenv('DATACROSS_MYSQL_USER', 'SEU_USUARIO_MYSQL'),
    'password': os.getenv('DATACROSS_MYSQL_PASSWORD', 'SUA_SENHA_MYSQL'),
    'database': os.getenv('DATACROSS_MYSQL_DATABASE', 'datacross_db'),
}

DASHBOARD_CACHE = os.path.join(BASE_DIR, 'dashboard_cache.json')
SCHEDULE_HOURS = [7, 11, 15]

ATTENTION_CACHE = os.path.join(BASE_DIR, 'attention_cache.json')
ATTENTION_SCHEDULE_HOURS = [7, 12, 15]

QUOTA_CACHE = os.path.join(BASE_DIR, 'quota_cache.json')
QUOTA_SCHEDULE_HOURS = [7, 12, 15]
QUOTA_LIMIT = 150

ORACLE_INSTANT_CLIENT_PATH = os.getenv(
    'DATACROSS_ORACLE_INSTANT_CLIENT_PATH',
    r'C:\oracle\instantclient_19_24',
)
ORACLE_CONFIG = {
    'usuario': os.getenv('DATACROSS_ORACLE_USER', 'SEU_USUARIO_ORACLE'),
    'senha': os.getenv('DATACROSS_ORACLE_PASSWORD', 'SUA_SENHA_ORACLE'),
    'host': os.getenv('DATACROSS_ORACLE_HOST', 'SEU_HOST_ORACLE'),
    'database': os.getenv('DATACROSS_ORACLE_DATABASE', 'SEU_SERVICE_NAME_ORACLE'),
    'port': int(os.getenv('DATACROSS_ORACLE_PORT', '1521')),
}

# Chave fica somente no servidor. Nao coloque chave real neste arquivo modelo.
CARD_USAGE_API_URL = os.getenv(
    'DATACROSS_CARD_USAGE_API_URL',
    'https://api.example.com.br/webservice/get/cardusage',
)
CARD_USAGE_API_KEY = os.getenv(
    'DATACROSS_CARD_USAGE_API_KEY',
    'SUA_CHAVE_CARD_USAGE',
)
