from flask import Blueprint, request, jsonify, session
from werkzeug.security import generate_password_hash
from sqlalchemy import text

# Import the pre-configured db engine and decorators
from core.database import engine
from modules.auth import admin_required

admin_bp = Blueprint('admin', __name__)

@admin_bp.route('/api/admin/users', methods=['GET'])
@admin_required
def admin_list_users():
    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT id, username, email, is_admin, perm_dashboard, perm_analise, perm_cruzamento, perm_relatorio, perm_higienizacao, perm_acompanhar_higienizacao, created_at, last_login FROM datacross_web.datacross_users ORDER BY id"
        )).mappings().fetchall()
        users = [dict(r) for r in rows]
        for u in users:
            for k, v in u.items():
                if v is not None and not isinstance(v, (int, str, float, bool)):
                    u[k] = str(v)
        return jsonify({'users': users}), 200

@admin_bp.route('/api/admin/users', methods=['POST'])
@admin_required
def admin_create_user():
    data = request.json or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    email = data.get('email', '').strip() or None
    is_admin = int(data.get('is_admin', 0))
    
    if not username or not password:
        return jsonify({'error': 'Usuário e senha obrigatórios'}), 400
    if len(password) < 4:
        return jsonify({'error': 'Senha deve ter pelo menos 4 caracteres'}), 400
    
    with engine.connect() as conn:
        exists = conn.execute(text(
            "SELECT id FROM datacross_web.datacross_users WHERE username = :u"
        ), {'u': username}).fetchone()
        if exists:
            return jsonify({'error': 'Usuário já existe'}), 409
        
        conn.execute(text("""
            INSERT INTO datacross_web.datacross_users 
            (username, email, password_hash, is_admin, perm_dashboard, perm_analise, perm_cruzamento, perm_relatorio, perm_higienizacao, perm_acompanhar_higienizacao)
            VALUES (:username, :email, :pw, :is_admin, :pd, :pa, :pc, :pr, :ph, :pah)
        """), {
            'username': username,
            'email': email,
            'pw': generate_password_hash(password),
            'is_admin': is_admin,
            'pd': int(data.get('perm_dashboard', 1)),
            'pa': int(data.get('perm_analise', 1)),
            'pc': int(data.get('perm_cruzamento', 1)),
            'pr': int(data.get('perm_relatorio', 1)),
            'ph': int(data.get('perm_higienizacao', 0)),
            'pah': int(data.get('perm_acompanhar_higienizacao', 0)),
        })
        conn.commit()
        return jsonify({'ok': True, 'msg': f'Usuário {username} criado'}), 201

@admin_bp.route('/api/admin/users/<int:user_id>', methods=['PUT'])
@admin_required
def admin_update_user(user_id):
    data = request.json or {}
    
    # Prevent admin from removing their own admin flag
    if user_id == session.get('user_id') and 'is_admin' in data and not data['is_admin']:
        return jsonify({'error': 'Você não pode remover seu próprio acesso admin'}), 400
    
    with engine.connect() as conn:
        sets = []
        params = {'id': user_id}
        
        if 'email' in data:
            sets.append("email = :email")
            params['email'] = data['email'].strip() or None
        if 'is_admin' in data:
            sets.append("is_admin = :is_admin")
            params['is_admin'] = int(data['is_admin'])
        for perm in ['perm_dashboard', 'perm_analise', 'perm_cruzamento', 'perm_relatorio', 'perm_higienizacao', 'perm_acompanhar_higienizacao']:
            if perm in data:
                sets.append(f"{perm} = :{perm}")
                params[perm] = int(data[perm])
        
        if not sets:
            return jsonify({'error': 'Nenhuma alteração enviada'}), 400
        
        conn.execute(text(f"UPDATE datacross_web.datacross_users SET {', '.join(sets)} WHERE id = :id"), params)
        conn.commit()

        if user_id == session.get('user_id'):
            refreshed = conn.execute(text("""
                SELECT is_admin, perm_dashboard, perm_analise, perm_cruzamento, perm_relatorio, perm_higienizacao, perm_acompanhar_higienizacao
                FROM datacross_web.datacross_users
                WHERE id = :id
            """), {'id': user_id}).mappings().fetchone()
            if refreshed:
                session['is_admin'] = bool(refreshed['is_admin'])
                session['permissions'] = {
                    'dashboard': bool(refreshed['perm_dashboard']),
                    'analise': bool(refreshed['perm_analise']),
                    'cruzamento': bool(refreshed['perm_cruzamento']),
                    'relatorio': bool(refreshed['perm_relatorio']),
                    'higienizacao': bool(refreshed['perm_higienizacao']),
                    'acompanhar_higienizacao': bool(refreshed.get('perm_acompanhar_higienizacao', False)),
                    'anomalia': bool((session.get('permissions') or {}).get('anomalia', False)),
                }

        return jsonify({'ok': True}), 200

@admin_bp.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@admin_required
def admin_delete_user(user_id):
    if user_id == session.get('user_id'):
        return jsonify({'error': 'Você não pode excluir seu próprio usuário'}), 400
    
    with engine.connect() as conn:
        conn.execute(text("DELETE FROM datacross_web.datacross_users WHERE id = :id"), {'id': user_id})
        conn.commit()
        return jsonify({'ok': True}), 200

@admin_bp.route('/api/admin/users/<int:user_id>/reset_password', methods=['POST'])
@admin_required
def admin_reset_password(user_id):
    data = request.json or {}
    new_pass = data.get('password', '')
    if not new_pass or len(new_pass) < 4:
        return jsonify({'error': 'Senha deve ter pelo menos 4 caracteres'}), 400
    
    with engine.connect() as conn:
        conn.execute(text(
            "UPDATE datacross_web.datacross_users SET password_hash = :pw WHERE id = :id"
        ), {'pw': generate_password_hash(new_pass), 'id': user_id})
        conn.commit()
        return jsonify({'ok': True}), 200
