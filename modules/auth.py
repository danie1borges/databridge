from functools import wraps
from flask import Blueprint, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import text
from core.database import engine

auth_bp = Blueprint('auth', __name__)

def init_db():
    """Create users table and default admin if not exists."""
    with engine.connect() as conn:
        conn.execute(text("CREATE DATABASE IF NOT EXISTS datacross_web DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS datacross_web.datacross_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NOT NULL UNIQUE,
                email VARCHAR(255),
                password_hash VARCHAR(255) NOT NULL,
                is_admin TINYINT(1) DEFAULT 0,
                perm_dashboard TINYINT(1) DEFAULT 1,
                perm_analise TINYINT(1) DEFAULT 1,
                perm_cruzamento TINYINT(1) DEFAULT 1,
                perm_relatorio TINYINT(1) DEFAULT 1,
                perm_higienizacao TINYINT(1) DEFAULT 0,
                perm_anomalia TINYINT(1) DEFAULT 0,
                perm_acompanhar_higienizacao TINYINT(1) DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME NULL
            )
        """))
        
        # Add column to existing table if it doesn't exist
        try:
            conn.execute(text("ALTER TABLE datacross_web.datacross_users ADD COLUMN perm_anomalia TINYINT(1) DEFAULT 0"))
            conn.commit()
            print('  [AUTH] Coluna perm_anomalia adicionada com sucesso.')
        except Exception as e:
            pass
        try:
            conn.execute(text("ALTER TABLE datacross_web.datacross_users ADD COLUMN perm_higienizacao TINYINT(1) DEFAULT 0"))
            conn.commit()
            print('  [AUTH] Coluna perm_higienizacao adicionada com sucesso.')
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE datacross_web.datacross_users ADD COLUMN perm_acompanhar_higienizacao TINYINT(1) DEFAULT 0"))
            conn.commit()
            print('  [AUTH] Coluna perm_acompanhar_higienizacao adicionada com sucesso.')
        except Exception:
            pass
        
        # Create history table for bulk search
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS datacross_web.datacross_historico_massa (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                nome_arquivo VARCHAR(255) NOT NULL,
                data_geracao DATETIME DEFAULT CURRENT_TIMESTAMP,
                usuario_gerou VARCHAR(100) NOT NULL,
                total_cpfs INT NOT NULL,
                CONSTRAINT fk_datacross_historico_massa_user
                    FOREIGN KEY (user_id) REFERENCES datacross_web.datacross_users(id) ON DELETE CASCADE
            )
        """))
        
        conn.commit()
        
        # Create default admin if table is empty
        count = conn.execute(text("SELECT COUNT(*) FROM datacross_web.datacross_users")).scalar()
        if count == 0:
            conn.execute(text("""
                INSERT INTO datacross_web.datacross_users 
                (username, email, password_hash, is_admin, perm_dashboard, perm_analise, perm_cruzamento, perm_relatorio)
                VALUES (:user, :email, :pw, 1, 1, 1, 1, 1)
            """), {
                'user': 'admin',
                'email': 'admin@example.com',
                'pw': generate_password_hash('admin123')
            })
            conn.commit()
            print('  [AUTH] Admin default criado: admin / admin123')

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Não autenticado'}), 401
        return f(*args, **kwargs)
    return decorated

def build_permissions_from_user(row):
    if not row:
        return {}
    return {
        'dashboard': bool(row.get('perm_dashboard')),
        'analise': bool(row.get('perm_analise')),
        'cruzamento': bool(row.get('perm_cruzamento')),
        'relatorio': bool(row.get('perm_relatorio')),
        'higienizacao': bool(row.get('perm_higienizacao')),
        'anomalia': bool(row.get('perm_anomalia')),
        'acompanhar_higienizacao': bool(row.get('perm_acompanhar_higienizacao')),
    }

def get_current_user():
    user_id = session.get('user_id')
    if not user_id:
        return None
    with engine.connect() as conn:
        return conn.execute(text("""
            SELECT
                id, username, email, is_admin,
                perm_dashboard, perm_analise, perm_cruzamento, perm_relatorio,
                perm_higienizacao, perm_anomalia, perm_acompanhar_higienizacao
            FROM datacross_web.datacross_users
            WHERE id = :id
        """), {'id': user_id}).mappings().fetchone()

def user_has_permission(permission):
    row = get_current_user()
    if not row:
        return False
    if row.get('is_admin'):
        return True
    permissions = build_permissions_from_user(row)
    return bool(permissions.get(permission))

def permission_required(permission):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if 'user_id' not in session:
                return jsonify({'error': 'Nao autenticado'}), 401
            if not user_has_permission(permission):
                return jsonify({'error': 'Acesso negado'}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Não autenticado'}), 401
        row = get_current_user()
        if not row or not row.get('is_admin'):
            return jsonify({'error': 'Acesso negado - admin requerido'}), 403
        return f(*args, **kwargs)
    return decorated

@auth_bp.route('/api/login', methods=['POST'])
def api_login():
    data = request.json or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    
    if not username or not password:
        return jsonify({'error': 'Usuário e senha obrigatórios'}), 400
    
    with engine.connect() as conn:
        row = conn.execute(text(
            "SELECT * FROM datacross_web.datacross_users WHERE username = :u"
        ), {'u': username}).mappings().fetchone()
        
        if not row or not check_password_hash(row['password_hash'], password):
            return jsonify({'error': 'Usuário ou senha inválidos'}), 401
        
        # Update last_login
        conn.execute(text(
            "UPDATE datacross_web.datacross_users SET last_login = NOW() WHERE id = :id"
        ), {'id': row['id']})
        conn.commit()
        
        permissions = build_permissions_from_user(row)

        # Set session. Permission checks read the current DB row on protected routes.
        session['user_id'] = row['id']
        session['username'] = row['username']
        
        return jsonify({
            'user': {
                'id': row['id'],
                'username': row['username'],
                'email': row['email'],
                'is_admin': bool(row['is_admin']),
                'permissions': permissions
            }
        }), 200

@auth_bp.route('/api/logout', methods=['POST'])
def api_logout():
    session.clear()
    return jsonify({'ok': True}), 200

@auth_bp.route('/api/me', methods=['GET'])
def api_me():
    if 'user_id' not in session:
        return jsonify({'authenticated': False}), 401
    row = get_current_user()
    if not row:
        session.clear()
        return jsonify({'authenticated': False}), 401
    return jsonify({
        'authenticated': True,
        'user': {
            'id': row['id'],
            'username': row['username'],
            'is_admin': bool(row['is_admin']),
            'permissions': build_permissions_from_user(row)
        }
    }), 200
