# -*- coding: utf-8 -*-
import os
import time
import logging
import threading
from flask import Flask, render_template, redirect, session, jsonify
from flask_socketio import SocketIO

from core.config import SECRET_KEY, UPLOAD_FOLDER, DASHBOARD_CACHE, ATTENTION_CACHE
from modules.auth import auth_bp, init_db
from modules.admin import admin_bp
from modules.dashboard import (
    dashboard_bp,
    refresh_dashboard_cache,
    refresh_attention_cache,
    dashboard_scheduler,
)
from modules.search import search_bp
from modules.report import report_bp, warm_report_filters_cache
from modules.bulk_process import register_socketio_events, bulk_bp

# Gerado uma vez na inicialização — muda a cada restart do servidor
BUILD_ID = str(int(time.time()))

app = Flask(__name__)
app.config['SECRET_KEY'] = SECRET_KEY
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Strict'
app.config['SESSION_COOKIE_SECURE'] = os.getenv('DATABRIDGE_COOKIE_SECURE', '0') == '1'

socketio = SocketIO(app, cors_allowed_origins=None, async_mode='threading', logger=False, engineio_logger=False)

app.register_blueprint(auth_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(dashboard_bp)
app.register_blueprint(search_bp)
app.register_blueprint(report_bp)
app.register_blueprint(bulk_bp)

register_socketio_events(socketio)


SUPPRESSED_ACCESS_LOG_PATHS = (
    '/api/admin/hygiene_jobs',
    '/api/relatorio_higienizacao/status',
    '/api/version',
)


class SuppressPollingAccessLog(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        return not any(path in message for path in SUPPRESSED_ACCESS_LOG_PATHS)


logging.getLogger('werkzeug').addFilter(SuppressPollingAccessLog())


@app.route('/')
def index():
    if 'user_id' in session:
        return redirect('/app')
    return render_template('login.html')


@app.route('/app')
def app_view():
    if 'user_id' not in session:
        return redirect('/')
    from modules.auth import get_current_user, build_permissions_from_user
    row = get_current_user()
    if not row:
        session.clear()
        return redirect('/')
    current_user = {
        'id': row['id'],
        'username': row['username'],
        'is_admin': bool(row['is_admin']),
        'permissions': build_permissions_from_user(row)
    }
    return render_template('index.html', current_user=current_user, build_id=BUILD_ID)


@app.route('/api/version')
def get_version():
    return jsonify({'build_id': BUILD_ID})


if __name__ == '__main__':
    if not os.path.exists(app.config['UPLOAD_FOLDER']):
        os.makedirs(app.config['UPLOAD_FOLDER'])

    init_db()
    print('  [AUTH] Sistema de autenticacao inicializado')

    if not os.path.exists(DASHBOARD_CACHE):
        refresh_dashboard_cache()
    else:
        print('  [CACHE] Cache do dashboard existente.')

    if not os.path.exists(ATTENTION_CACHE):
        refresh_attention_cache()
    else:
        print('  [ATTENTION] Cache de atencao existente.')

    warm_report_filters_cache()

    scheduler_thread = threading.Thread(target=dashboard_scheduler, daemon=True)
    scheduler_thread.start()
    print('  [CACHE] Scheduler iniciado')

    print('  [SERVER] Iniciando servidor SocketIO (threading) em http://0.0.0.0:5004')
    socketio.run(app, host='0.0.0.0', port=5004, debug=False, use_reloader=False, log_output=True, allow_unsafe_werkzeug=True)
