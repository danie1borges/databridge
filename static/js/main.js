// Global App Names Mapping
const APP_NAMES = {
    "400": "V.T.", "58": "SYS_ID", "500": "COMUM", "600": "GRATUIDADE_P", "610": "GRATUIDADE_CA",
    "611": "ACOMP.", "900": "ESCOLAR GRATUIDADE", "1000": "OPERADOR-AP1000", "1007": "SRV-APP-AP1007",
    "1008": "DATA-COL-AP1008", "1023": "C.D.2-AP1023", "100": "BOTOEIRAS", "1011": "DATA-COL-AP1011",
    "700": "FUNCIONAL", "800": "IDOSO", "3": "SGC", "111": "ABT", "110": "QRCODE",
    "301": "FISCAL TRANSP", "302": "CONS TUTELAR", "303": "POLICIA CIVL", "304": "EMTU",
    "305": "DATABRIDGE", "306": "FUNC TEMP 03", "307": "FUNC INTEGRACAO", "308": "FUNC TEMP 02",
    "309": "INSS - EMPRESAS", "310": "FUNC SISTEMA", "605": "GRATUIDADE_C", "270": "DTP-PNE C/AC",
    "271": "DTP-EST PRIV", "204": "DTP-FISC TRANSP", "267": "DTP-FUN SIS T02", "299": "E1 VLR",
    "298": "E1 ERROR", "297": "E1 GRAT", "910": "ESCOLAR", "201": "DTP-VALE COMUM", "205": "DTP-ESTUDANTE",
    "206": "DTP - PNE", "263": "DTP - FUNC EMTU", "207": "DTP - V.T", "209": "DTP-FUNC SISTEM",
    "219": "DTP-PORTADOR", "220": "DTP - C.TUTELAR", "222": "DTP - P. CIVIL", "264": "DTP - DATABRIDGE",
    "269": "DTP- INSS", "248": "DTP-CADEIRANTE", "265": "DTP-TEMPORARIO", "266": "DTP-INTEGRACAO",
    "311": "FUNC TEMP", "620": "ESPECIAL (NC)", "625": "ESP C/AC (NC)", "312": "FUNC IBGE",
    "112": "EMV", "505": "P SOCIAL", "260": "MANUTENCAO", "905": "ESCOLAR GRATUIDADE MUNICIPAL"
};

document.addEventListener('DOMContentLoaded', () => {
    // ===========================
    //  AUTH CHECK ON LOAD
    // ===========================
    let currentUser = null;

    // ===========================
    //  UTILITY
    // ===========================
    function debounce(fn, ms) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    }

    // ===========================
    //  DASHBOARD PANEL TABS
    // ===========================
    let _activeDashTab = localStorage.getItem('dashboard-active-tab') || 'attention';
    const _dashTabLoaded = { attention: false, hygiene: false, quota: false };

    function activateDashboardTab(tab) {
        _activeDashTab = tab;
        localStorage.setItem('dashboard-active-tab', tab);

        document.querySelectorAll('.dash-panel-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        const panelMap = {
            attention: document.getElementById('attention-panel'),
            hygiene:   document.getElementById('hygiene-dashboard-panel'),
            quota:     document.getElementById('quota-panel'),
        };
        Object.entries(panelMap).forEach(([key, el]) => {
            if (!el) return;
            el.classList.toggle('panel-tab-active', key === tab);
        });

        if (tab === 'attention' && !_dashTabLoaded.attention) {
            _dashTabLoaded.attention = true;
            loadAttentionPanel();
        } else if (tab === 'hygiene' && !_dashTabLoaded.hygiene) {
            _dashTabLoaded.hygiene = true;
            loadHygieneDashboardPanel();
        } else if (tab === 'quota' && !_dashTabLoaded.quota) {
            _dashTabLoaded.quota = true;
            loadQuotaPanel();
        }
    }

    function loadDashboardView() {
        loadDashboardStats();
        // Ativa a aba salva (mostra o painel correto)
        activateDashboardTab(_activeDashTab);
        // Carrega atenção e higienização em background para popular as badges,
        // independente de qual aba está ativa. Cota é sob demanda (consulta pesada).
        if (!_dashTabLoaded.attention) {
            _dashTabLoaded.attention = true;
            loadAttentionPanel();
        }
        if (!_dashTabLoaded.hygiene) {
            _dashTabLoaded.hygiene = true;
            loadHygieneDashboardPanel();
        }
    }

    function showLogin() {
        window.location.href = '/';
    }

    function clearAppState() {
        cancelSingleSearch?.();
        disconnectBulkSocket?.();
        stopJobsPolling();
        // Clear single search results
        const singleResults = document.getElementById('single-search-results');
        if (singleResults) { singleResults.classList.add('hidden'); singleResults.innerHTML = ''; }
        const cpfInput = document.getElementById('cpf-input');
        if (cpfInput) cpfInput.value = '';

        // Clear bulk search results
        const bulkResults = document.getElementById('bulk-search-results');
        if (bulkResults) { bulkResults.classList.add('hidden'); bulkResults.innerHTML = ''; }
        const bulkInput = document.getElementById('bulk-cpf-textarea');
        if (bulkInput) bulkInput.value = '';

        // Clear report table
        const reportBody = document.getElementById('report-table-body');
        if (reportBody) reportBody.innerHTML = '';
        const reportContainer = document.getElementById('report-container');
        if (reportContainer) reportContainer.classList.add('hidden');
        const btnExport = document.getElementById('btn-export-report');
        if (btnExport) btnExport.classList.add('hidden');
        document.getElementById('btn-report-hygiene')?.classList.add('hidden');
        resetReportFilterBuilderState?.();
    }

    function initApp() {
        // Force landscape on mobile
        const rotateOverlay = document.getElementById('rotate-overlay');
        if (rotateOverlay) rotateOverlay.classList.add('active');
        if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
        }

        applyPermissions();
        if (currentUser) {
            const perms = currentUser.permissions || {};
            const canViewHygieneDashboard = currentUser.is_admin === true || perms.higienizacao === true;
            const hygieneTab = document.getElementById('dash-tab-hygiene');
            if (hygieneTab) hygieneTab.style.display = canViewHygieneDashboard ? '' : 'none';
            if (!canViewHygieneDashboard && _activeDashTab === 'hygiene') {
                _activeDashTab = 'attention';
            }
        }
        navigateToFirstAllowed();
        reconnectActiveHygieneJobFromServer();
    }

    function navigateToFirstAllowed() {
        if (!currentUser) return;
        const perms = currentUser.permissions || {};
        // Order of preference for initial view
        const viewOrder = [
            { perm: 'dashboard', navId: 'nav-dashboard', viewId: 'dashboard-view' },
            { perm: 'analise', navId: 'nav-analise', viewId: 'single-search-view' },
            { perm: 'cruzamento', navId: 'nav-cruzamento', viewId: 'bulk-search-view' },
            { perm: 'relatorio', navId: 'nav-relatorio', viewId: 'report-view' },
            { perm: 'higienizacao', navId: 'nav-hygiene-history', viewId: 'hygiene-history-view' },
        ];
        // Find first allowed view
        let target = null;
        for (const v of viewOrder) {
            if (perms[v.perm] !== false) {
                target = v;
                break;
            }
        }
        if (!target && currentUser.is_admin) {
            target = { navId: 'nav-admin', viewId: 'admin-view' };
        }
        if (!target) return;

        // Activate the correct nav item and view
        const navItems = document.querySelectorAll('.nav-item');
        const viewSections = document.querySelectorAll('.view-section');
        navItems.forEach(n => n.classList.remove('active'));
        viewSections.forEach(v => v.classList.add('hidden'));

        const navEl = document.getElementById(target.navId);
        if (navEl) navEl.classList.add('active');
        const viewEl = document.getElementById(target.viewId);
        if (viewEl) viewEl.classList.remove('hidden');

        // Load data for the target view
        if (target.viewId === 'dashboard-view') {
            loadDashboardView();
        }
        else if (target.viewId === 'report-view') {
            loadRelatorioFilters();
        }
        else if (target.viewId === 'hygiene-history-view') {
            initHygieneHistoryView();
        }
        else if (target.viewId === 'admin-view') loadAdminUsers();
    }

    function applyPermissions() {
        if (!currentUser) return;
        const perms = currentUser.permissions || {};
        // Show/hide sidebar items based on permissions
        const navMap = {
            'nav-dashboard': perms.dashboard !== false,
            'nav-analise': perms.analise !== false,
            'nav-cruzamento': perms.cruzamento !== false,
            'nav-relatorio': perms.relatorio !== false,
            'nav-hygiene-history': currentUser.is_admin === true || perms.higienizacao === true,
            'nav-admin': currentUser.is_admin === true,
        };
        for (const [id, show] of Object.entries(navMap)) {
            const el = document.getElementById(id);
            if (el) el.style.display = show ? '' : 'none';
        }

        // User display
        const avatar = document.getElementById('user-avatar');
        const displayName = document.getElementById('user-display-name');
        const displayRole = document.getElementById('user-display-role');
        if (avatar) avatar.textContent = (currentUser.username || '?').substring(0, 2).toUpperCase();
        if (displayName) displayName.textContent = currentUser.username;
        if (displayRole) displayRole.textContent = currentUser.is_admin ? 'Administrador' : 'Usuário';
    }

    // Logout (desktop sidebar + mobile bottom nav)
    async function performLogout() {
        disconnectBulkSocket();
        clearHygieneSessionUi();
        await fetch('/api/logout', { method: 'POST' });
        if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
        window.location.href = '/';
    }
    document.getElementById('btn-logout').addEventListener('click', performLogout);
    document.getElementById('bn-logout').addEventListener('click', performLogout);

    // ===========================
    //  QUICK SEARCH (Ctrl+K)
    // ===========================
    const qsOverlay = document.getElementById('quick-search-overlay');
    const qsInput = document.getElementById('quick-search-input');

    function openQuickSearch() {
        if (!currentUser) return;
        const perms = currentUser.permissions || {};
        if (perms.analise === false) return; // No permission
        qsOverlay.classList.remove('hidden');
        qsInput.value = '';
        requestAnimationFrame(() => {
            qsOverlay.classList.add('show');
            qsInput.focus();
        });
    }

    function closeQuickSearch() {
        qsOverlay.classList.remove('show');
        setTimeout(() => qsOverlay.classList.add('hidden'), 180);
    }

    // Ctrl+K shortcut
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            if (qsOverlay.classList.contains('hidden')) {
                openQuickSearch();
            } else {
                closeQuickSearch();
            }
        }
        if (e.key === 'Escape' && !qsOverlay.classList.contains('hidden')) {
            closeQuickSearch();
        }
    });

    // Close on backdrop click
    qsOverlay.addEventListener('click', (e) => {
        if (e.target === qsOverlay) closeQuickSearch();
    });

    // Enter submits search
    qsInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = qsInput.value.trim();
            if (!value) return;

            closeQuickSearch();

            // Navigate to single-search-view
            const navItems = document.querySelectorAll('.nav-item');
            const viewSections = document.querySelectorAll('.view-section');
            navItems.forEach(n => n.classList.remove('active'));
            viewSections.forEach(v => v.classList.add('hidden'));
            const navAnalise = document.getElementById('nav-analise');
            if (navAnalise) navAnalise.classList.add('active');
            const viewAnalise = document.getElementById('single-search-view');
            if (viewAnalise) viewAnalise.classList.remove('hidden');

            // Set input and submit
            const cpfInput = document.getElementById('cpf-input');
            if (cpfInput) cpfInput.value = value;
            const form = document.getElementById('single-search-form');
            if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
        }
    });

    // Navigation
    const navItems = document.querySelectorAll('.nav-item');
    const viewSections = document.querySelectorAll('.view-section');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = item.getAttribute('data-target');
            cancelSingleSearch();

            // Permissions check
            if (targetId === 'admin-view' && (!currentUser || !currentUser.is_admin)) return;
            if (targetId === 'hygiene-history-view' && (!currentUser || (currentUser.is_admin !== true && currentUser.permissions?.higienizacao !== true))) return;

            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            viewSections.forEach(v => {
                if (v.id === targetId) {
                    v.classList.remove('hidden');
                } else {
                    v.classList.add('hidden');
                }
            });

            // Stop jobs polling when leaving the hygiene history view
            if (targetId !== 'hygiene-history-view') stopJobsPolling();

            if (targetId === 'dashboard-view') {
                loadDashboardView();
            } else if (targetId === 'report-view') {
                loadRelatorioFilters();
            } else if (targetId === 'hygiene-history-view') {
                initHygieneHistoryView();
            } else if (targetId === 'admin-view') {
                loadAdminUsers();
            } else if (targetId === 'bulk-search-view') {
                ensureBulkSocket();
                loadBulkHistory();
            } else if (procDashboard.classList.contains('hidden')) {
                disconnectBulkSocket();
            }
        });
    });

    // --- DASHBOARD LOGIC ---
    function getNextRefreshHour() {
        const h = new Date().getHours();
        const schedule = [7, 11, 15];
        for (const s of schedule) {
            if (h < s) return String(s).padStart(2, '0') + ':00';
        }
        return '07:00'; // Tomorrow
    }

    async function loadDashboardStats() {
        const container = document.getElementById('stats-container');

        container.innerHTML = `
            <div id="dashboard-loader" class="loader-wrapper" style="grid-column: 1 / -1; min-height: 300px;">
                <div class="modern-spinner"></div>
                <div class="loader-text">Conectando ao Data Lake...</div>
                <div class="loader-subtext">Calculando estatísticas das bases...</div>
            </div>
        `;

        try {
            const res = await fetch('/api/dashboard_stats');
            const data = await res.json();

            if (data.error) {
                container.innerHTML = `<p class="text-danger">Erro ao carregar dados: ${data.error}</p>`;
                return;
            }

            // --- Calculate KPIs ---
            const bases = [
                { key: 'cad_unico', name: 'LegacyDB', icon: 'fa-credit-card', color: '#EC4899' },
                { key: 'clientes', name: 'Portal Cliente', icon: 'fa-users', color: '#3B82F6' },
                { key: 'estudantes', name: 'Portal Estudante', icon: 'fa-user-graduate', color: '#8B5CF6' },
                { key: 'abt', name: 'ABT Data', icon: 'fa-database', color: '#10B981' },
                { key: 'wifi', name: 'Wifi Max', icon: 'fa-wifi', color: '#F59E0B' },
                { key: 'whatsapp', name: 'Whatsapp', icon: 'fa-brands fa-whatsapp', color: '#22C55E' },
            ];

            let totalRegistros = 0;
            let totalAlcancaveis = 0;
            let completudeSum = 0;
            let completudeCount = 0;

            bases.forEach(b => {
                const s = data[b.key];
                if (!s) return;
                const total = s.total || 0;
                totalRegistros += total;

                // Alcançáveis = tem email OU celular
                const semEmail = (s.sem_email !== null && s.sem_email !== undefined) ? s.sem_email : total;
                const semCelular = (s.sem_celular !== null && s.sem_celular !== undefined) ? s.sem_celular : total;
                const comEmail = total - semEmail;
                const comCelular = total - semCelular;
                const alcancaveis = Math.max(comEmail, comCelular); // at least one channel
                totalAlcancaveis += alcancaveis;

                // Completude: average of email% + celular%
                if (total > 0) {
                    const emailPct = (comEmail / total) * 100;
                    const celularPct = (comCelular / total) * 100;
                    completudeSum += (emailPct + celularPct) / 2;
                    completudeCount++;
                }
            });

            const completudeMedia = completudeCount > 0 ? (completudeSum / completudeCount).toFixed(1) : 0;

            // Populate KPIs
            const fmt = (n) => n.toLocaleString('pt-BR');
            document.getElementById('kpi-total-registros').textContent = fmt(totalRegistros);
            document.getElementById('kpi-alcancaveis').textContent = fmt(totalAlcancaveis);
            document.getElementById('kpi-completude').textContent = completudeMedia + '%';
            // --- Show last updated banner ---
            const banner = document.getElementById('dashboard-updated-banner');
            if (banner && data.last_updated) {
                banner.textContent = 'Dados atualizados em: ' + data.last_updated + ' • Próx. atualização às ' + getNextRefreshHour() + 'h';
                banner.classList.remove('hidden');
            }

            // --- Render stat cards ---
            container.innerHTML = bases.map(b => createStatCard(b.name, data[b.key], b.icon, b.color)).join('');

            // --- Render unified analytics panel ---
            const analyticsPanel = document.getElementById('bases-analytics-panel');
            if (analyticsPanel) analyticsPanel.classList.remove('hidden');

            renderBasesComparisonTable(data, bases);
            renderDashboardCharts(data);
            renderGapBars(data, bases);

            // Wire up analytics tab switching (idempotent)
            if (!analyticsPanel?.dataset.tabsBound) {
                if (analyticsPanel) analyticsPanel.dataset.tabsBound = 'true';
                document.querySelectorAll('.bap-tab').forEach(tab => {
                    tab.addEventListener('click', () => {
                        const view = tab.dataset.bap;
                        document.querySelectorAll('.bap-tab').forEach(t => t.classList.toggle('active', t === tab));
                        document.querySelectorAll('.bap-view').forEach(v => v.classList.toggle('hidden', v.id !== `bap-view-${view}`));
                    });
                });
            }

        } catch (e) {
            console.error(e);
            container.innerHTML = `<p class="text-danger">Erro de conexão.</p>`;
        }

        loadEstudantesSemLegacyDB();
    }

    async function loadEstudantesSemLegacyDB() {
        const panel = document.getElementById('esm-panel');
        if (!panel) return;

        const badgeCartao  = document.getElementById('esm-count-cartao');
        const badgeLegacyDB = document.getElementById('esm-count-legacydb');
        try {
            const res  = await fetch('/api/dashboard/anomalias_estudantis');
            const data = await res.json();
            if (data.error) {
                badgeCartao.textContent = badgeLegacyDB.textContent = '—';
                return;
            }
            badgeCartao.textContent  = (data.sem_cartao  || 0).toLocaleString('pt-BR');
            badgeLegacyDB.textContent = (data.sem_legacydb || 0).toLocaleString('pt-BR');
            document.getElementById('btn-esm-export-cartao').disabled  = false;
            document.getElementById('btn-esm-export-legacydb').disabled = false;

            function wireExport(btnId, url) {
                const btn = document.getElementById(btnId);
                if (!btn) return;
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando...';
                    try {
                        const res = await fetch(url);
                        if (!res.ok) throw new Error('Erro ao gerar planilha');
                        const disposition = res.headers.get('Content-Disposition') || '';
                        const match = disposition.match(/filename[^;=\n]*=["']?([^"';\n]+)/);
                        const filename = match ? match[1] : 'export.xlsx';
                        const blob = await res.blob();
                        const objectUrl = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = objectUrl; a.download = filename;
                        document.body.appendChild(a); a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(objectUrl);
                        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Concluído!';
                        setTimeout(() => {
                            btn.disabled = false;
                            btn.innerHTML = '<i class="fa-solid fa-file-excel"></i> Exportar XLSX';
                        }, 2500);
                    } catch (e) {
                        btn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> Erro';
                        setTimeout(() => {
                            btn.disabled = false;
                            btn.innerHTML = '<i class="fa-solid fa-file-excel"></i> Exportar XLSX';
                        }, 3000);
                    }
                }, { once: true });
            }
            wireExport('btn-esm-export-cartao',  '/api/dashboard/estudantes_sem_cartao/export');
            wireExport('btn-esm-export-legacydb', '/api/dashboard/estudantes_sem_legacydb/export');
        } catch (e) {
            badgeCartao.textContent = badgeLegacyDB.textContent = '—';
        }
    }

    function createStatCard(title, statObj, icon, color) {
        const formatNum = (num) => (num !== null && num !== undefined) ? num.toLocaleString('pt-BR') : '0';

        let value = 0;
        let progressHtml = '';
        let qualityScore = null;
        let scoreClass = '';
        let scoreLabel = '';

        if (statObj !== null && typeof statObj === 'object') {
            value = statObj.total || 0;
            const total = value;

            const calcPct = (sem) => {
                if (sem === null || sem === undefined || !total) return null;
                return ((total - sem) / total) * 100;
            };

            const emailPct  = calcPct(statObj.sem_email);
            const celPct    = calcPct(statObj.sem_celular);
            const endPct    = calcPct(statObj.sem_endereco);

            // Quality score = avg of available metrics
            const vals = [emailPct, celPct, endPct].filter(v => v !== null);
            if (vals.length) {
                qualityScore = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(0);
                const s = Number(qualityScore);
                if (s >= 80)      { scoreClass = 'sc-score-excelente'; scoreLabel = 'Excelente'; }
                else if (s >= 55) { scoreClass = 'sc-score-boa';       scoreLabel = 'Boa'; }
                else if (s >= 30) { scoreClass = 'sc-score-regular';   scoreLabel = 'Regular'; }
                else              { scoreClass = 'sc-score-critica';   scoreLabel = 'Crítica'; }
            }

            const buildProg = (label, pct, barColor) => {
                if (pct === null) return '';
                const pctFmt = pct.toFixed(1);
                const textColor = pct >= 70 ? '#34D399' : pct >= 40 ? '#FBBF24' : '#F87171';
                return `<div class="sc-prog-row">
                    <span class="sc-prog-label">${label}</span>
                    <div class="sc-prog-track"><div class="sc-prog-fill" style="width:${pctFmt}%;background:${barColor};"></div></div>
                    <span class="sc-prog-pct" style="color:${textColor}">${pctFmt}%</span>
                </div>`;
            };

            const rows = [
                buildProg('E-mail',   emailPct, '#3B82F6'),
                buildProg('Celular',  celPct,   '#22C55E'),
                buildProg('Endereço', endPct,   '#F59E0B'),
            ].filter(Boolean).join('');

            if (rows) {
                progressHtml = `<div class="sc-prog-list">${rows}</div>`;
            }
        } else {
            value = statObj || 0;
        }

        const scoreHtml = qualityScore !== null
            ? `<span class="sc-score-badge ${scoreClass}">${scoreLabel} ${qualityScore}%</span>`
            : '';

        const iconClass = icon.includes(' ') ? icon : 'fa-solid ' + icon;

        return `<div class="stat-card-v2">
            <div class="sc-accent-bar" style="background:${color};"></div>
            <div class="sc-content">
                <div class="sc-top">
                    <div class="sc-icon" style="background:${color}22;color:${color};">
                        <i class="${iconClass}"></i>
                    </div>
                    <div class="sc-name-wrap">
                        <div class="sc-name">${title}</div>
                        ${scoreHtml}
                    </div>
                </div>
                <div class="sc-total">${formatNum(value)}<span class="sc-total-label">registros</span></div>
                ${progressHtml}
            </div>
        </div>`;
    }

    function renderBasesComparisonTable(data, bases) {
        const container = document.getElementById('bases-comparison-table-container');
        if (!container) return;

        const calcPct = (total, sem) => {
            if (!total || sem === null || sem === undefined) return null;
            return ((total - sem) / total * 100);
        };
        const fmtPct = (v) => v !== null ? v.toFixed(1) + '%' : '—';
        const fmtNum = (n) => (n || 0).toLocaleString('pt-BR');

        const pctCell = (pct) => {
            if (pct === null) return `<td class="bct-pct bct-na">—</td>`;
            const cls = pct >= 70 ? 'bct-good' : pct >= 40 ? 'bct-warn' : 'bct-bad';
            const w = pct.toFixed(0);
            return `<td class="bct-pct ${cls}">
                <div class="bct-bar-wrap"><div class="bct-bar-fill" style="width:${w}%"></div></div>
                <span>${fmtPct(pct)}</span>
            </td>`;
        };

        let rows = '';
        bases.forEach(b => {
            const s = data[b.key];
            if (!s) return;
            const total = s.total || 0;
            const ePct  = calcPct(total, s.sem_email);
            const cPct  = calcPct(total, s.sem_celular);
            const enPct = calcPct(total, s.sem_endereco);

            const vals = [ePct, cPct, enPct].filter(v => v !== null);
            const score = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null;
            const scoreClass = score === null ? 'bct-na' : score >= 80 ? 'bct-good' : score >= 55 ? 'bct-warn-score' : score >= 30 ? 'bct-warn' : 'bct-bad';

            rows += `<tr>
                <td class="bct-base-cell">
                    <span class="bct-dot" style="background:${b.color}"></span>
                    <i class="${b.icon.includes(' ') ? b.icon : 'fa-solid ' + b.icon}" style="color:${b.color};font-size:0.85rem;"></i>
                    <span>${b.name}</span>
                </td>
                <td class="bct-total">${fmtNum(total)}</td>
                ${pctCell(ePct)}
                ${pctCell(cPct)}
                ${pctCell(enPct)}
                <td class="bct-score ${scoreClass}">${score !== null ? score.toFixed(0) + '%' : '—'}</td>
            </tr>`;
        });

        container.innerHTML = `<table class="bases-comparison-table">
            <thead>
                <tr>
                    <th>Base</th>
                    <th>Total</th>
                    <th><i class="fa-solid fa-envelope" style="color:#3B82F6"></i> E-mail</th>
                    <th><i class="fa-solid fa-mobile-screen-button" style="color:#22C55E"></i> Celular</th>
                    <th><i class="fa-solid fa-location-dot" style="color:#F59E0B"></i> Endereço</th>
                    <th><i class="fa-solid fa-star" style="color:#A78BFA"></i> Score</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    let dashboardCharts = [];
    function renderDashboardCharts(data) {
        dashboardCharts.forEach(c => c.destroy());
        dashboardCharts = [];

        Chart.defaults.color = '#94a3b8';
        Chart.defaults.font.family = "'Inter', sans-serif";
        Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio, 2);

        const baseLabels = ['LegacyDB', 'Portal Cliente', 'Portal Estudante', 'ABT', 'Wifi Max', 'WhatsApp'];
        const baseKeys  = ['cad_unico', 'clientes', 'estudantes', 'abt', 'wifi', 'whatsapp'];

        const calcP = (key, sem) => {
            const s = data[key];
            if (!s || !s.total) return 0;
            const v = s[sem];
            if (v === null || v === undefined) return 0;
            return parseFloat(((s.total - v) / s.total * 100).toFixed(1));
        };

        const emailData    = baseKeys.map(k => calcP(k, 'sem_email'));
        const celularData  = baseKeys.map(k => calcP(k, 'sem_celular'));
        const enderecoData = baseKeys.map(k => calcP(k, 'sem_endereco'));

        // Horizontal grouped bar: bases on Y-axis, 3 metrics as datasets
        const hbarCtx = document.getElementById('hbarChart')?.getContext('2d');
        if (hbarCtx) {
            dashboardCharts.push(new Chart(hbarCtx, {
                type: 'bar',
                data: {
                    labels: baseLabels,
                    datasets: [
                        { label: 'E-mail',   data: emailData,    backgroundColor: 'rgba(59,130,246,0.8)',  borderRadius: 3 },
                        { label: 'Celular',  data: celularData,  backgroundColor: 'rgba(34,197,94,0.8)',   borderRadius: 3 },
                        { label: 'Endereço', data: enderecoData, backgroundColor: 'rgba(245,158,11,0.75)', borderRadius: 3 },
                    ]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { position: 'top', labels: { boxWidth: 11, padding: 14, font: { size: 11 } } },
                        tooltip: {
                            callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%` }
                        }
                    },
                    scales: {
                        x: {
                            beginAtZero: true, max: 100,
                            ticks: { callback: v => v + '%', font: { size: 11 } },
                            grid: { color: 'rgba(255,255,255,0.05)' }
                        },
                        y: {
                            ticks: { font: { size: 11 } },
                            grid: { display: false }
                        }
                    }
                }
            }));
        }
    }

    function renderGapBars(data, bases) {
        const container = document.getElementById('gaps-container');
        if (!container) return;

        const calcGap = (total, sem) => {
            if (!total || sem === null || sem === undefined) return null;
            return (sem / total) * 100;
        };

        // heatmap: classe + cor de fundo baseada no percentual de lacuna
        const hmClass = (pct) => pct <= 10 ? 'lhm-good' : pct <= 40 ? 'lhm-warn' : 'lhm-bad';

        const cellHtml = (pct) => {
            if (pct === null) return `<div class="lhm-cell lhm-na"><span class="lhm-pct">—</span></div>`;
            const cls = hmClass(pct);
            const w = Math.min(pct, 100).toFixed(0);
            return `<div class="lhm-cell ${cls}">
                <span class="lhm-pct">${pct.toFixed(1)}%</span>
                <div class="lhm-mini-bar"><div class="lhm-mini-fill" style="width:${w}%"></div></div>
            </div>`;
        };

        let html = `<div class="lacunas-heatmap">
            <div class="lhm-header-row">
                <div class="lhm-col-base"></div>
                <div class="lhm-col-head"><i class="fa-solid fa-envelope"></i> Sem E-mail</div>
                <div class="lhm-col-head"><i class="fa-solid fa-mobile-screen-button"></i> Sem Celular</div>
            </div>`;

        bases.forEach(b => {
            const s = data[b.key];
            if (!s || !s.total) return;
            const emailGap  = calcGap(s.total, s.sem_email);
            const celGap    = calcGap(s.total, s.sem_celular);
            const iconClass = b.icon.includes(' ') ? b.icon : 'fa-solid ' + b.icon;

            html += `<div class="lhm-row">
                <div class="lhm-col-base">
                    <i class="${iconClass}" style="color:${b.color}"></i>
                    <span style="color:${b.color};font-weight:600;">${b.name}</span>
                </div>
                ${cellHtml(emailGap)}
                ${cellHtml(celGap)}
            </div>`;
        });

        html += `<div class="lhm-legend">
            <span class="lhm-leg-item lhm-good"><i class="fa-solid fa-circle"></i> Baixa ≤10%</span>
            <span class="lhm-leg-item lhm-warn"><i class="fa-solid fa-circle"></i> Média 11–40%</span>
            <span class="lhm-leg-item lhm-bad"><i class="fa-solid fa-circle"></i> Alta >40%</span>
        </div></div>`;

        container.innerHTML = html;
    }


    // ===========================
    //  ATTENTION PANEL LOGIC
    // ===========================
    let attentionData = null;
    let attentionVisibleUsers = [];
    let attentionRenderedCount = 0;
    let attentionTableScrollBound = false;
    const ATTENTION_TABLE_CHUNK_SIZE = 60;
    const ATTENTION_TABLE_SCROLL_THRESHOLD = 180;
    let hygieneDashboardData = null;

    function getNextAttentionRefreshHour() {
        const h = new Date().getHours();
        const schedule = [7, 12, 15];
        for (const s of schedule) {
            if (h < s) return String(s).padStart(2, '0') + ':00';
        }
        return '07:00';
    }

    async function loadAttentionPanel() {
        try {
            const res = await fetch('/api/attention_users');
            const data = await res.json();

            if (data.error) {
                console.error('Attention panel error:', data.error);
                return;
            }

            attentionData = data;
            const users = data.users || [];
            const porResp = data.por_responsavel || {};
            const total = data.total || 0;

            // --- KPIs ---
            document.getElementById('attention-total-badge').textContent = total;
            const tabBadgeAttention = document.getElementById('tab-badge-attention');
            if (tabBadgeAttention) tabBadgeAttention.textContent = total;
            document.getElementById('att-kpi-total').textContent = total.toLocaleString('pt-BR');
            document.getElementById('att-kpi-responsaveis').textContent = Object.keys(porResp).length;

            // Recent 24h
            const now = new Date();
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const recent24h = users.filter(u => {
                if (!u.data_criacao) return false;
                const d = new Date(u.data_criacao.replace(' ', 'T'));
                return d >= yesterday;
            }).length;
            document.getElementById('att-kpi-recent').textContent = recent24h;

            // Unique types (split combined types by ; or ,)
            const uniqueTypes = new Set();
            users.forEach(u => {
                if (!u.tipo || u.tipo.trim() === '') return;
                u.tipo.split(/[;,]/).map(t => t.trim()).filter(Boolean).forEach(t => uniqueTypes.add(t));
            });
            document.getElementById('att-kpi-types').textContent = uniqueTypes.size;

            // --- Info Banner ---
            const banner = document.getElementById('attention-updated-banner');
            if (banner && data.last_updated) {
                banner.innerHTML = `<i class="fa-regular fa-clock"></i> <span>Dados atualizados em: <strong>${data.last_updated}</strong> • Próx. atualização às <strong>${getNextAttentionRefreshHour()}h</strong></span>`;
            }

            // --- Responsible Breakdown Bars ---
            renderAttentionRespBars(porResp, total);

            // --- Timeline Bars (by day) ---
            renderAttentionTimeline(users);

            // --- Type Breakdown Bars ---
            renderAttentionTypeBars(users, total);

            // --- Populate filter dropdown ---
            const filterSelect = document.getElementById('attention-filter-resp');
            filterSelect.innerHTML = '<option value="">Todos</option>';
            Object.keys(porResp).sort().forEach(resp => {
                const opt = document.createElement('option');
                opt.value = resp;
                opt.textContent = `${resp} (${porResp[resp]})`;
                filterSelect.appendChild(opt);
            });

            // --- Render table ---
            renderAttentionTable(users);

            // --- Filter event ---
            filterSelect.onchange = () => {
                const val = filterSelect.value;
                const filtered = val ? users.filter(u => u.registrado_por === val) : users;
                renderAttentionTable(filtered);
            };

        } catch (e) {
            console.error('Attention panel fetch error:', e);
        }
    }

    function renderAttentionRespBars(porResp, total) {
        const container = document.getElementById('attention-resp-bars');
        if (!container) return;

        const sorted = Object.entries(porResp).sort((a, b) => b[1] - a[1]);
        const maxCount = sorted.length > 0 ? sorted[0][1] : 1;

        const barColors = [
            'linear-gradient(90deg, #F59E0B, #D97706)',
            'linear-gradient(90deg, #EF4444, #DC2626)',
            'linear-gradient(90deg, #3B82F6, #2563EB)',
            'linear-gradient(90deg, #8B5CF6, #7C3AED)',
            'linear-gradient(90deg, #10B981, #059669)',
            'linear-gradient(90deg, #EC4899, #DB2777)',
            'linear-gradient(90deg, #06B6D4, #0891B2)',
            'linear-gradient(90deg, #F97316, #EA580C)',
        ];

        let html = '';
        sorted.forEach((entry, idx) => {
            const [name, count] = entry;
            const pct = maxCount > 0 ? (count / maxCount * 100).toFixed(0) : 0;
            const bg = barColors[idx % barColors.length];
            const pctOfTotal = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
            const safeId = 'att-resp-detail-' + idx;
            html += `<div class="att-bar-row att-bar-clickable" data-resp="${name}" data-detail-id="${safeId}">
                <span class="att-bar-label att-bar-label-click" title="Clique para ver tipos de ${name}">
                    <i class="fa-solid fa-chevron-right att-chevron" id="chevron-${safeId}"></i>
                    ${name}
                </span>
                <span class="att-bar-count-badge">${count}</span>
                <div class="att-bar-track">
                    <div class="att-bar-fill" style="width:${Math.max(pct, 4)}%;background:${bg};"></div>
                </div>
                <span class="att-bar-pct-badge">${pctOfTotal}%</span>
            </div>
            <div class="att-resp-detail-panel" id="${safeId}" style="display:none;"></div>`;
        });

        if (sorted.length === 0) {
            html = '<div style="color:var(--text-sec);font-size:0.8rem;text-align:center;padding:20px;">Nenhum dado disponível</div>';
        }

        container.innerHTML = html;

        // Add click events
        container.querySelectorAll('.att-bar-clickable').forEach(row => {
            row.addEventListener('click', () => {
                const respName = row.dataset.resp;
                const detailId = row.dataset.detailId;
                const panel = document.getElementById(detailId);
                const chevron = document.getElementById('chevron-' + detailId);
                if (!panel) return;

                // Toggle
                if (panel.style.display === 'none') {
                    // Close all others first
                    container.querySelectorAll('.att-resp-detail-panel').forEach(p => {
                        p.style.display = 'none';
                    });
                    container.querySelectorAll('.att-chevron').forEach(c => {
                        c.style.transform = 'rotate(0deg)';
                    });

                    // Build type breakdown for this responsible
                    const users = attentionData ? attentionData.users || [] : [];
                    const respUsers = users.filter(u => u.registrado_por === respName);
                    const typeCounts = {};
                    let missingEmail = 0;
                    let missingPhone = 0;
                    respUsers.forEach(u => {
                        if (u.missing_email === true || u.missing_email === 1) missingEmail++;
                        if (u.missing_phone === true || u.missing_phone === 1) missingPhone++;

                        if (!u.tipo || u.tipo.trim() === '') {
                            typeCounts['Sem Tipo'] = (typeCounts['Sem Tipo'] || 0) + 1;
                            return;
                        }

                        u.tipo.split(/[;,]/).map(t => t.trim()).filter(Boolean).forEach(t => {
                            typeCounts[t] = (typeCounts[t] || 0) + 1;
                        });
                    });

                    const typeSorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
                    const typeTotal = typeSorted.reduce((s, e) => s + e[1], 0);

                    const pillColors = ['#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#06B6D4'];

                    let detailHtml = `<div class="att-detail-header" style="flex-direction: column; align-items: flex-start; gap: 8px;">
                        <div style="display: flex; justify-content: space-between; width: 100%;">
                            <span>Tipos cadastrados por <strong>${respName}</strong></span>
                            <span class="att-detail-total">${respUsers.length} cadastros</span>
                        </div>
                        <div style="display: flex; gap: 12px; font-size: 0.75rem; color: var(--text-sec); border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 6px; width: 100%;">
                            <span><i class="fa-solid fa-envelope" style="color: #F87171; margin-right:4px;"></i>${missingEmail} sem e-mail</span>
                            <span><i class="fa-solid fa-phone" style="color: #F87171; margin-right:4px;"></i>${missingPhone} sem celular</span>
                        </div>
                    </div><div class="att-detail-pills">`;

                    if (typeSorted.length === 0) {
                        detailHtml += '<span style="color:var(--text-sec);font-size:0.75rem;">Sem tipo definido</span>';
                    } else {
                        typeSorted.forEach((entry, i) => {
                            const [typeName, typeCount] = entry;
                            const typePct = typeTotal > 0 ? ((typeCount / typeTotal) * 100).toFixed(1) : 0;
                            const color = pillColors[i % pillColors.length];
                            detailHtml += `<div class="att-detail-pill">
                                <span class="att-detail-dot" style="background:${color};"></span>
                                <span class="att-detail-name">${typeName}</span>
                                <span class="att-detail-count">${typeCount}</span>
                                <span class="att-detail-pct">${typePct}%</span>
                            </div>`;
                        });
                    }

                    detailHtml += '</div>';
                    panel.innerHTML = detailHtml;
                    panel.style.display = 'block';
                    if (chevron) chevron.style.transform = 'rotate(90deg)';
                } else {
                    panel.style.display = 'none';
                    if (chevron) chevron.style.transform = 'rotate(0deg)';
                }
            });
        });
    }

    function renderAttentionTypeBars(users, total) {
        const container = document.getElementById('attention-type-bars');
        if (!container) return;

        // Count types - each user's tipo may be separated by ; or ,
        const typeCounts = {};
        users.forEach(u => {
            if (!u.tipo || u.tipo.trim() === '') {
                typeCounts['Sem Tipo'] = (typeCounts['Sem Tipo'] || 0) + 1;
                return;
            }
            // Split by ; or , (the DB uses semicolons)
            const tipos = u.tipo.split(/[;,]/).map(t => t.trim()).filter(Boolean);
            tipos.forEach(t => {
                typeCounts[t] = (typeCounts[t] || 0) + 1;
            });
        });

        const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
        const maxCount = sorted.length > 0 ? sorted[0][1] : 1;
        // Total for percentage = sum of all types (may be > user count due to multi-type)
        const typeTotal = sorted.reduce((s, e) => s + e[1], 0);

        const typeColors = [
            'linear-gradient(90deg, #8B5CF6, #7C3AED)',
            'linear-gradient(90deg, #3B82F6, #2563EB)',
            'linear-gradient(90deg, #10B981, #059669)',
            'linear-gradient(90deg, #F59E0B, #D97706)',
            'linear-gradient(90deg, #EF4444, #DC2626)',
            'linear-gradient(90deg, #EC4899, #DB2777)',
            'linear-gradient(90deg, #06B6D4, #0891B2)',
        ];

        let html = '';
        sorted.forEach((entry, idx) => {
            const [name, count] = entry;
            const pct = maxCount > 0 ? (count / maxCount * 100).toFixed(0) : 0;
            const bg = typeColors[idx % typeColors.length];
            const pctOfTotal = typeTotal > 0 ? ((count / typeTotal) * 100).toFixed(1) : 0;
            html += `<div class="att-bar-row">
                <span class="att-bar-label" title="${name}">${name}</span>
                <span class="att-bar-count-badge">${count}</span>
                <div class="att-bar-track">
                    <div class="att-bar-fill" style="width:${Math.max(pct, 4)}%;background:${bg};"></div>
                </div>
                <span class="att-bar-pct-badge">${pctOfTotal}%</span>
            </div>`;
        });

        if (sorted.length === 0) {
            html = '<div style="color:var(--text-sec);font-size:0.8rem;text-align:center;padding:20px;">Nenhum dado disponível</div>';
        }

        container.innerHTML = html;
    }

    function renderAttentionTimeline(users) {
        const container = document.getElementById('attention-timeline-bars');
        if (!container) return;

        // Group by date
        const byDay = {};
        users.forEach(u => {
            if (!u.data_criacao) return;
            const dateKey = u.data_criacao.split(' ')[0]; // YYYY-MM-DD
            if (byDay[dateKey] === undefined) byDay[dateKey] = 0;
            byDay[dateKey]++;
        });

        // Generate labels dynamically from existing data
        const dayLabels = Object.keys(byDay).sort().map(key => {
            // Using noon to safely avoid timezone offset shifts to the previous day
            const d = new Date(key + 'T12:00:00');
            const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            const label = `${dayNames[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
            return { key, label };
        });

        const todayKey = new Date().toISOString().split('T')[0];

        const maxDayCount = Math.max(...Object.values(byDay), 1);

        let html = '';
        dayLabels.forEach(dl => {
            const count = byDay[dl.key] || 0;
            const pct = maxDayCount > 0 ? (count / maxDayCount * 100).toFixed(0) : 0;
            const isToday = dl.key === todayKey;
            const dayStyle = isToday ? 'color:#60A5FA;font-weight:700;' : '';
            html += `<div class="att-timeline-row">
                <span class="att-timeline-day" style="${dayStyle}">${dl.label}${isToday ? ' •' : ''}</span>
                <div class="att-timeline-track">
                    <div class="att-timeline-fill" style="width:${count > 0 ? pct : 0}%;">${count > 0 ? count : ''}</div>
                </div>
                <span class="att-timeline-count">${count}</span>
            </div>`;
        });

        container.innerHTML = html;
    }

    function renderAttentionTable(users) {
        const tbody = document.getElementById('attention-table-body');
        const countLabel = document.getElementById('attention-showing-count');

        if (!users || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-sec);padding:30px;"><i class="fa-solid fa-circle-check" style="color:var(--success);margin-right:6px;"></i> Nenhum cadastro incompleto encontrado!</td></tr>';
            countLabel.textContent = 'Mostrando 0 registros';
            return;
        }

        countLabel.textContent = `Mostrando ${users.length} registro${users.length !== 1 ? 's' : ''}`;

        const formatDate = (dateStr) => {
            if (!dateStr) return '—';
            // Handle YYYY-MM-DD HH:MM:SS format
            const parts = dateStr.split(' ');
            if (parts[0]) {
                const dp = parts[0].split('-');
                if (dp.length === 3) {
                    const time = parts[1] ? parts[1].substring(0, 5) : '';
                    return `${dp[2]}/${dp[1]}/${dp[0]}${time ? ' ' + time : ''}`;
                }
            }
            return dateStr;
        };

        const formatBirthDate = (dateStr) => {
            if (!dateStr || dateStr === 'None') return '—';
            const dp = dateStr.split('-');
            if (dp.length === 3) {
                return `${dp[2]}/${dp[1]}/${dp[0]}`;
            }
            return dateStr;
        };

        let html = '';
        users.forEach(u => {
            const noEmail = u.missing_email === true || u.missing_email === 1;
            const noPhone = u.missing_phone === true || u.missing_phone === 1;
            let badges = [];
            if (noEmail) badges.push('<span style="background:rgba(248,113,113,0.15);color:#F87171;padding:2px 6px;border-radius:4px;font-size:0.7rem;margin-right:4px;"><i class="fa-solid fa-envelope"></i> E-mail</span>');
            if (noPhone) badges.push('<span style="background:rgba(248,113,113,0.15);color:#F87171;padding:2px 6px;border-radius:4px;font-size:0.7rem;"><i class="fa-solid fa-phone"></i> Celular</span>');

            html += `<tr>
                <td style="font-family:monospace;font-size:0.78rem;">${u.cpf || '—'}</td>
                <td>${u.nome || '—'}</td>
                <td><span style="background:rgba(139,92,246,0.12);color:#A78BFA;padding:2px 8px;border-radius:8px;font-size:0.72rem;font-weight:600;">${u.tipo || '—'}</span></td>
                <td>${formatBirthDate(u.data_nascimento)}</td>
                <td>${u.endereco || '<span style="color:var(--text-sec);font-style:italic;">Sem endereço</span>'}</td>
                <td>${badges.join('')}</td>
                <td><span class="att-resp-badge">${u.registrado_por || '—'}</span></td>
                <td>${formatDate(u.data_criacao)}</td>
            </tr>`;
        });

        tbody.innerHTML = html;
    }

    function formatAttentionCreatedAt(dateStr) {
        if (!dateStr) return '—';
        const parts = dateStr.split(' ');
        if (parts[0]) {
            const dp = parts[0].split('-');
            if (dp.length === 3) {
                const time = parts[1] ? parts[1].substring(0, 5) : '';
                return `${dp[2]}/${dp[1]}/${dp[0]}${time ? ' ' + time : ''}`;
            }
        }
        return dateStr;
    }

    function formatAttentionBirthDate(dateStr) {
        if (!dateStr || dateStr === 'None') return '—';
        const dp = dateStr.split('-');
        if (dp.length === 3) {
            return `${dp[2]}/${dp[1]}/${dp[0]}`;
        }
        return dateStr;
    }

    function buildAttentionTableRowsHtml(users) {
        return users.map(u => {
            const noEmail = u.missing_email === true || u.missing_email === 1;
            const noPhone = u.missing_phone === true || u.missing_phone === 1;
            const badges = [];
            if (noEmail) badges.push('<span style="background:rgba(248,113,113,0.15);color:#F87171;padding:2px 6px;border-radius:4px;font-size:0.7rem;margin-right:4px;"><i class="fa-solid fa-envelope"></i> E-mail</span>');
            if (noPhone) badges.push('<span style="background:rgba(248,113,113,0.15);color:#F87171;padding:2px 6px;border-radius:4px;font-size:0.7rem;"><i class="fa-solid fa-phone"></i> Celular</span>');

            return `<tr>
                <td style="font-family:monospace;font-size:0.78rem;">${u.cpf || '—'}</td>
                <td>${u.nome || '—'}</td>
                <td><span style="background:rgba(139,92,246,0.12);color:#A78BFA;padding:2px 8px;border-radius:8px;font-size:0.72rem;font-weight:600;">${u.tipo || '—'}</span></td>
                <td>${formatAttentionBirthDate(u.data_nascimento)}</td>
                <td>${u.endereco || '<span style="color:var(--text-sec);font-style:italic;">Sem endereço</span>'}</td>
                <td>${badges.join('')}</td>
                <td><span class="att-resp-badge">${u.registrado_por || '—'}</span></td>
                <td>${formatAttentionCreatedAt(u.data_criacao)}</td>
            </tr>`;
        }).join('');
    }

    function updateAttentionShowingCount() {
        const countLabel = document.getElementById('attention-showing-count');
        if (!countLabel) return;

        const total = attentionVisibleUsers.length;
        if (total === 0) {
            countLabel.textContent = 'Mostrando 0 registros';
            return;
        }

        countLabel.textContent = `Mostrando ${total.toLocaleString('pt-BR')} registro${total !== 1 ? 's' : ''}`;
    }

    function appendAttentionTableChunk() {
        const tbody = document.getElementById('attention-table-body');
        if (!tbody || attentionRenderedCount >= attentionVisibleUsers.length) return;

        const nextChunk = attentionVisibleUsers.slice(
            attentionRenderedCount,
            attentionRenderedCount + ATTENTION_TABLE_CHUNK_SIZE
        );
        if (!nextChunk.length) return;

        tbody.insertAdjacentHTML('beforeend', buildAttentionTableRowsHtml(nextChunk));
        attentionRenderedCount += nextChunk.length;
    }

    function maybeAppendAttentionTableChunk() {
        const wrap = document.querySelector('.attention-table-wrap');
        if (!wrap) return;

        const distanceToBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
        if (distanceToBottom <= ATTENTION_TABLE_SCROLL_THRESHOLD) {
            appendAttentionTableChunk();
        }
    }

    function fillAttentionTableViewport() {
        const wrap = document.querySelector('.attention-table-wrap');
        if (!wrap) return;

        while (
            attentionRenderedCount < attentionVisibleUsers.length &&
            wrap.scrollHeight <= wrap.clientHeight + ATTENTION_TABLE_SCROLL_THRESHOLD
        ) {
            appendAttentionTableChunk();
        }
    }

    function bindAttentionTableScroll() {
        if (attentionTableScrollBound) return;

        const wrap = document.querySelector('.attention-table-wrap');
        if (!wrap) return;

        wrap.addEventListener('scroll', maybeAppendAttentionTableChunk);
        attentionTableScrollBound = true;
    }

    function renderAttentionTable(users) {
        const tbody = document.getElementById('attention-table-body');
        const wrap = document.querySelector('.attention-table-wrap');
        if (!tbody) return;

        attentionVisibleUsers = Array.isArray(users) ? users : [];
        attentionRenderedCount = 0;

        if (wrap) {
            wrap.scrollTop = 0;
        }

        if (attentionVisibleUsers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-sec);padding:30px;"><i class="fa-solid fa-circle-check" style="color:var(--success);margin-right:6px;"></i> Nenhum cadastro incompleto encontrado!</td></tr>';
            updateAttentionShowingCount();
            return;
        }

        tbody.innerHTML = '';
        updateAttentionShowingCount();
        appendAttentionTableChunk();
        fillAttentionTableViewport();
        bindAttentionTableScroll();
        requestAnimationFrame(maybeAppendAttentionTableChunk);
    }

    function formatHygieneDateTime(dateStr) {
        if (!dateStr) return '—';
        const parsed = new Date(String(dateStr).replace(' ', 'T'));
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toLocaleString('pt-BR');
        }
        return String(dateStr);
    }

    function renderHygieneRankingBars(ranking) {
        const container = document.getElementById('hygiene-ranking-bars');
        if (!container) return;

        if (!ranking || ranking.length === 0) {
            container.innerHTML = '<div style="color:var(--text-sec);font-size:0.8rem;text-align:center;padding:20px;">Nenhum lote de higienização encontrado.</div>';
            return;
        }

        const maxCount = Math.max(...ranking.map(item => Number(item.total_cartoes || 0)), 1);
        container.innerHTML = ranking.map((item, idx) => {
            const totalCartoes = Number(item.total_cartoes || 0);
            const pct = Math.max(6, Math.round((totalCartoes / maxCount) * 100));
            const colors = [
                'linear-gradient(90deg, #10B981, #059669)',
                'linear-gradient(90deg, #3B82F6, #2563EB)',
                'linear-gradient(90deg, #8B5CF6, #7C3AED)',
                'linear-gradient(90deg, #F59E0B, #D97706)',
                'linear-gradient(90deg, #EC4899, #DB2777)',
            ];
            return `<div class="att-bar-row">
                <span class="att-bar-label" title="${item.username || ''}">${idx + 1}. ${item.username || 'Desconhecido'}</span>
                <span class="att-bar-count-badge" title="${totalCartoes.toLocaleString('pt-BR')} cartões">${totalCartoes.toLocaleString('pt-BR')} cartões</span>
                <div class="att-bar-track">
                    <div class="att-bar-fill" style="width:${pct}%;background:${colors[idx % colors.length]};"></div>
                </div>
                <span class="att-bar-pct-badge">${Number(item.total_lotes || 0)} lotes</span>
            </div>`;
        }).join('');
    }

    function renderHygieneDailyBars(daily) {
        const container = document.getElementById('hygiene-daily-bars');
        if (!container) return;

        if (!daily || daily.length === 0) {
            container.innerHTML = '<div style="color:var(--text-sec);font-size:0.8rem;text-align:center;padding:20px;">Nenhum dado diário disponível.</div>';
            return;
        }

        const maxCount = Math.max(...daily.map(item => Number(item.total_cartoes || 0)), 1);
        container.innerHTML = daily.map(item => {
            const totalCartoes = Number(item.total_cartoes || 0);
            const totalLotes = Number(item.total_lotes || 0);
            const pct = totalCartoes > 0 ? Math.max(8, Math.round((totalCartoes / maxCount) * 100)) : 0;
            const parsed = new Date(`${item.date}T12:00:00`);
            const label = !Number.isNaN(parsed.getTime())
                ? parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
                : item.date;
            return `<div class="att-timeline-row">
                <span class="att-timeline-day">${label}</span>
                <div class="att-timeline-track">
                    <div class="att-timeline-fill" style="width:${pct}%;">${totalCartoes > 0 ? totalCartoes : ''}</div>
                </div>
                <span class="att-timeline-count">${totalLotes}</span>
            </div>`;
        }).join('');
    }

    function renderHygieneTable(details) {
        const tbody = document.getElementById('hygiene-table-body');
        const countLabel = document.getElementById('hygiene-showing-count');
        if (!tbody || !countLabel) return;

        if (!details || details.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-sec);padding:30px;"><i class="fa-solid fa-circle-info" style="margin-right:6px;"></i> Nenhum lote de higienização encontrado.</td></tr>';
            countLabel.textContent = 'Mostrando 0 registros';
            return;
        }

        countLabel.textContent = `Mostrando ${details.length.toLocaleString('pt-BR')} registro${details.length !== 1 ? 's' : ''}`;
        tbody.innerHTML = details.map(item => `
            <tr>
                <td><span class="att-resp-badge">${item.username || 'Desconhecido'}</span></td>
                <td><strong>${Number(item.total_cartoes || 0).toLocaleString('pt-BR')}</strong></td>
                <td>${formatHygieneDateTime(item.created_at)}</td>
                <td style="font-family:monospace;font-size:0.78rem;">${(item.sample_cpfs || []).join('<br>') || '—'}</td>
                <td style="font-family:monospace;font-size:0.78rem;">${(item.sample_cards || []).join('<br>') || '—'}</td>
                <td>${item.observation || '<span style="color:var(--text-sec);">Sem observação</span>'}</td>
            </tr>
        `).join('');
    }

    async function loadHygieneDashboardPanel() {
        const panel = document.getElementById('hygiene-dashboard-panel');
        if (!panel || !currentUser) return;

        const perms = currentUser.permissions || {};
        const canViewHygieneDashboard = currentUser.is_admin === true || perms.higienizacao === true;
        if (!canViewHygieneDashboard) return;

        try {
            const res = await fetch('/api/hygiene_dashboard_stats');
            const data = await res.json();
            if (!res.ok || data.error) {
                console.error('Hygiene dashboard error:', data.error || res.statusText);
                return;
            }

            hygieneDashboardData = data;
            const totals = data.totals || {};
            const ranking = data.ranking || [];
            const details = data.details || [];
            const daily = data.daily || [];

            document.getElementById('hygiene-total-badge').textContent = Number(totals.total_cartoes || 0).toLocaleString('pt-BR');
            const tabBadgeHygiene = document.getElementById('tab-badge-hygiene');
            if (tabBadgeHygiene) tabBadgeHygiene.textContent = Number(totals.total_cartoes || 0).toLocaleString('pt-BR');
            document.getElementById('hygiene-kpi-total-cartoes').textContent = Number(totals.total_cartoes || 0).toLocaleString('pt-BR');
            document.getElementById('hygiene-kpi-operadores').textContent = Number(totals.total_operadores || 0).toLocaleString('pt-BR');
            document.getElementById('hygiene-kpi-hoje').textContent = Number(totals.cartoes_hoje || 0).toLocaleString('pt-BR');
            document.getElementById('hygiene-kpi-lotes').textContent = Number(totals.total_lotes || 0).toLocaleString('pt-BR');

            const banner = document.getElementById('hygiene-updated-banner');
            if (banner) {
                banner.innerHTML = `<i class="fa-regular fa-clock"></i><span>Dados atualizados em: <strong>${data.last_updated || '—'}</strong> • Últimos 7 dias: <strong>${Number(totals.cartoes_7d || 0).toLocaleString('pt-BR')}</strong> cartões</span>`;
            }

            const filterSelect = document.getElementById('hygiene-filter-user');
            if (filterSelect) {
                filterSelect.innerHTML = '<option value="">Todos</option>';
                const usersMap = new Map();
                details.forEach(item => {
                    const username = item.username || 'Desconhecido';
                    usersMap.set(username, (usersMap.get(username) || 0) + Number(item.total_cartoes || 0));
                });
                [...usersMap.entries()]
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .forEach(([username, totalCartoes]) => {
                    const option = document.createElement('option');
                    option.value = username;
                    option.textContent = `${username} (${Number(totalCartoes || 0).toLocaleString('pt-BR')})`;
                    filterSelect.appendChild(option);
                });
                filterSelect.onchange = () => {
                    const selectedUser = filterSelect.value;
                    const filtered = selectedUser
                        ? details.filter(item => (item.username || '') === selectedUser)
                        : details;
                    renderHygieneTable(filtered);
                };
            }

            renderHygieneRankingBars(ranking);
            renderHygieneDailyBars(daily);
            renderHygieneTable(details);
        } catch (error) {
            console.error('Hygiene dashboard fetch error:', error);
        }
    }

    const hygieneHistoryFields = [
        { id: 'created_at', label: 'Data da execução', type: 'date' },
        { id: 'username', label: 'Operador Databridge', type: 'string', adminOnly: true },
        { id: 'adminpanel_username', label: 'Operador AdminPanel', type: 'string' },
        { id: 'observation', label: 'Observação', type: 'string' },
        { id: 'total_success', label: 'Quantidade de cartões', type: 'number' },
        { id: 'client_name', label: 'Nome do cliente', type: 'string' },
        { id: 'client_cpf', label: 'CPF do cliente', type: 'string' },
        { id: 'client_card', label: 'Cartão', type: 'string' },
    ];
    let hygieneHistoryRules = [{ field: 'created_at', operator: 'after', value: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) }];
    let hygieneHistoryInitialized = false;
    let hygieneHistoryPage = 1;
    let hygieneHistoryPerPage = 15;
    let hygieneHistoryTotalPages = 0;

    function getHygieneHistoryField(fieldId) {
        return hygieneHistoryFields.find(field => field.id === fieldId) || hygieneHistoryFields[0];
    }

    function getHygieneHistoryOperators(type) {
        if (type === 'date') return [
            { value: 'on', label: 'Na data' },
            { value: 'after', label: 'A partir de' },
            { value: 'before', label: 'Até a data' },
            { value: 'between', label: 'Entre datas' },
        ];
        if (type === 'number') return [
            { value: 'gte', label: 'Maior ou igual' },
            { value: 'lte', label: 'Menor ou igual' },
            { value: 'equals', label: 'Igual a' },
        ];
        return [
            { value: 'contains', label: 'Contém' },
            { value: 'equals', label: 'Igual a' },
        ];
    }

    function formatCpfBR(value) {
        const digits = String(value || '').replace(/\D/g, '').padStart(11, '0').slice(-11);
        if (!digits || digits === '00000000000') return '-';
        return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
    }

    function renderHygieneHistoryBuilder() {
        const builder = document.getElementById('hygiene-history-builder');
        if (!builder) return;
        const fields = hygieneHistoryFields.filter(field => !field.adminOnly || currentUser?.is_admin === true);
        const rulesHtml = hygieneHistoryRules.map((rule, index) => {
            const field = getHygieneHistoryField(rule.field);
            const operators = getHygieneHistoryOperators(field.type);
            const inputType = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text';
            const secondValue = rule.operator === 'between'
                ? `<input class="form-control hygiene-history-value-to" type="${inputType}" data-index="${index}" value="${escapeHtml(rule.value_to || '')}">`
                : '';
            return `
                <div class="filter-builder-rule hygiene-history-rule">
                    <div>
                        <label>Campo</label>
                        <select class="form-control hygiene-history-field" data-index="${index}">
                            ${fields.map(item => `<option value="${item.id}" ${item.id === rule.field ? 'selected' : ''}>${item.label}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label>Operador</label>
                        <select class="form-control hygiene-history-operator" data-index="${index}">
                            ${operators.map(op => `<option value="${op.value}" ${op.value === rule.operator ? 'selected' : ''}>${op.label}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label>Valor</label>
                        <div class="filter-builder-value-row ${rule.operator === 'between' ? 'dual' : ''}">
                            <input class="form-control hygiene-history-value" type="${inputType}" data-index="${index}" value="${escapeHtml(rule.value || '')}">
                            ${secondValue}
                        </div>
                    </div>
                    <button type="button" class="builder-chip-btn danger hygiene-history-remove" data-index="${index}">Excluir</button>
                </div>
            `;
        }).join('');

        builder.innerHTML = `
            <div class="filter-builder-group">
                <div class="filter-builder-group-header">
                    <div class="filter-builder-group-title">
                        <span>Grupo principal</span>
                        <div class="filter-builder-logic" aria-label="Condição do grupo">
                            <button type="button" class="active">E</button>
                            <button type="button" disabled>OU</button>
                        </div>
                    </div>
                    <div class="filter-builder-group-actions">
                        <button type="button" class="builder-chip-btn" id="hygiene-history-add-rule"><i class="fa-solid fa-plus"></i> Regra</button>
                    </div>
                </div>
                <div class="filter-builder-rules">
                    ${rulesHtml}
                </div>
            </div>
        `;

        builder.querySelectorAll('.hygiene-history-field').forEach(select => {
            select.addEventListener('change', () => {
                const index = Number(select.dataset.index);
                const field = getHygieneHistoryField(select.value);
                hygieneHistoryRules[index] = { field: field.id, operator: getHygieneHistoryOperators(field.type)[0].value, value: '' };
                renderHygieneHistoryBuilder();
            });
        });
        builder.querySelectorAll('.hygiene-history-operator').forEach(select => {
            select.addEventListener('change', () => {
                const index = Number(select.dataset.index);
                hygieneHistoryRules[index].operator = select.value;
                if (select.value !== 'between') delete hygieneHistoryRules[index].value_to;
                renderHygieneHistoryBuilder();
            });
        });
        builder.querySelectorAll('.hygiene-history-value').forEach(input => {
            input.addEventListener('input', () => hygieneHistoryRules[Number(input.dataset.index)].value = input.value);
        });
        builder.querySelectorAll('.hygiene-history-value-to').forEach(input => {
            input.addEventListener('input', () => hygieneHistoryRules[Number(input.dataset.index)].value_to = input.value);
        });
        builder.querySelectorAll('.hygiene-history-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                hygieneHistoryRules.splice(Number(btn.dataset.index), 1);
                if (!hygieneHistoryRules.length) {
                    const firstField = fields[0];
                    hygieneHistoryRules.push({ field: firstField.id, operator: getHygieneHistoryOperators(firstField.type)[0].value, value: '' });
                }
                renderHygieneHistoryBuilder();
            });
        });
        document.getElementById('hygiene-history-add-rule')?.addEventListener('click', () => {
            const firstField = fields[0];
            hygieneHistoryRules.push({ field: firstField.id, operator: getHygieneHistoryOperators(firstField.type)[0].value, value: '' });
            renderHygieneHistoryBuilder();
        });
    }

    function updateHygieneHistoryPagination(payload = {}, itemsLength = 0) {
        const count = document.getElementById('hygiene-history-count');
        const paginationInfo = document.getElementById('hygiene-history-pagination-info');
        const currentPageEl = document.getElementById('hygiene-history-current-page');
        const prevBtn = document.getElementById('hygiene-history-prev-page');
        const nextBtn = document.getElementById('hygiene-history-next-page');

        const total = Number(payload.total || 0);
        hygieneHistoryPage = Math.max(1, Number(payload.page || hygieneHistoryPage || 1));
        hygieneHistoryPerPage = Math.max(1, Number(payload.per_page || hygieneHistoryPerPage || 15));
        hygieneHistoryTotalPages = Math.max(0, Number(payload.total_pages || 0));

        const from = total ? ((hygieneHistoryPage - 1) * hygieneHistoryPerPage) + 1 : 0;
        const to = total ? Math.min(from + Number(itemsLength || 0) - 1, total) : 0;

        if (count) {
            count.textContent = total
                ? `Mostrando ${from.toLocaleString('pt-BR')}-${to.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}`
                : 'Mostrando 0 de 0';
        }
        if (paginationInfo) {
            paginationInfo.textContent = `Pagina ${hygieneHistoryPage.toLocaleString('pt-BR')} de ${hygieneHistoryTotalPages.toLocaleString('pt-BR')}`;
        }
        if (currentPageEl) currentPageEl.textContent = hygieneHistoryPage.toLocaleString('pt-BR');
        if (prevBtn) prevBtn.disabled = hygieneHistoryPage <= 1;
        if (nextBtn) nextBtn.disabled = !hygieneHistoryTotalPages || hygieneHistoryPage >= hygieneHistoryTotalPages;
    }

    function setHygieneHistoryPaginationBusy() {
        const paginationInfo = document.getElementById('hygiene-history-pagination-info');
        const currentPageEl = document.getElementById('hygiene-history-current-page');
        const prevBtn = document.getElementById('hygiene-history-prev-page');
        const nextBtn = document.getElementById('hygiene-history-next-page');

        if (paginationInfo) paginationInfo.textContent = 'Carregando paginas...';
        if (currentPageEl) currentPageEl.textContent = hygieneHistoryPage.toLocaleString('pt-BR');
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
    }

    async function loadHygieneHistory() {
        const tbody = document.getElementById('hygiene-history-body');
        const count = document.getElementById('hygiene-history-count');
        if (!tbody || !count) return;
        const pageSizeSelect = document.getElementById('hygiene-history-page-size');
        hygieneHistoryPerPage = Math.max(10, Number(pageSizeSelect?.value || hygieneHistoryPerPage || 15));
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-5"><div class="modern-spinner" style="margin:0 auto 12px;"></div>Carregando histórico...</td></tr>';
        count.textContent = 'Carregando...';
        setHygieneHistoryPaginationBusy();
        try {
            const res = await fetch('/api/hygiene_history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filters: { condition: 'AND', rules: hygieneHistoryRules },
                    page: hygieneHistoryPage,
                    per_page: hygieneHistoryPerPage,
                }),
            });
            const payload = await res.json();
            if (!res.ok) throw new Error(payload.error || 'Falha ao carregar histórico.');
            const items = payload.items || [];
            updateHygieneHistoryPagination(payload, items.length);
            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-5">Nenhum lote encontrado com estes filtros.</td></tr>';
                return;
            }
            tbody.innerHTML = items.map(item => `
                <tr class="hygiene-history-row" data-log-id="${escapeHtml(item.id || '')}" title="Clique para ver os detalhes do lote">
                    <td>${escapeHtml(item.created_at || '-')}</td>
                    <td><span class="att-resp-badge">${escapeHtml(item.username || 'Desconhecido')}</span></td>
                    <td>${escapeHtml(item.adminpanel_username || '-')}</td>
                    <td><strong>${Number(item.total_success || 0).toLocaleString('pt-BR')}</strong></td>
                    <td>${escapeHtml(item.observation || 'Sem observação')}</td>
                    <td>${escapeHtml(item.filter_summary || 'Filtro não registrado')}</td>
                </tr>
            `).join('');
            tbody.querySelectorAll('.hygiene-history-row').forEach(row => {
                row.addEventListener('click', () => openHygieneHistoryDetail(row.dataset.logId));
            });
        } catch (error) {
            count.textContent = 'Erro';
            updateHygieneHistoryPagination({ total: 0, page: 1, per_page: hygieneHistoryPerPage, total_pages: 0 }, 0);
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger py-5">${escapeHtml(error.message)}</td></tr>`;
        }
    }

    function ensureHygieneHistoryDetailModal() {
        let modal = document.getElementById('hygiene-history-detail-modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'hygiene-history-detail-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-card glass-panel hygiene-history-detail-card">
                <div class="card-usage-modal-header">
                    <div>
                        <div class="card-usage-title"><i class="fa-solid fa-list-check"></i> Detalhes do lote</div>
                        <div class="card-usage-subtitle" id="hygiene-history-detail-subtitle">Carregando...</div>
                    </div>
                    <div class="hygiene-history-detail-actions">
                        <button type="button" id="hygiene-history-detail-export" class="btn-attention-export" disabled>
                            <i class="fa-solid fa-file-excel"></i> Exportar XLSX
                        </button>
                        <button class="modal-close-btn" type="button" onclick="closeHygieneHistoryDetailModal()" title="Fechar">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>
                <div id="hygiene-history-detail-content" class="hygiene-history-detail-content"></div>
            </div>
        `;
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeHygieneHistoryDetailModal();
        });
        document.body.appendChild(modal);
        return modal;
    }

    window.closeHygieneHistoryDetailModal = function () {
        const modal = document.getElementById('hygiene-history-detail-modal');
        if (modal) modal.classList.remove('show');
    };

    async function openHygieneHistoryDetail(logId) {
        if (!logId) return;

        const modal = ensureHygieneHistoryDetailModal();
        const subtitle = document.getElementById('hygiene-history-detail-subtitle');
        const content = document.getElementById('hygiene-history-detail-content');
        const exportBtn = document.getElementById('hygiene-history-detail-export');
        subtitle.textContent = `Lote #${logId}`;
        if (exportBtn) {
            exportBtn.disabled = true;
            exportBtn.dataset.logId = '';
            exportBtn.innerHTML = '<i class="fa-solid fa-file-excel"></i> Exportar XLSX';
        }
        content.innerHTML = `
            <div class="card-usage-loading">
                <div class="modern-spinner"></div>
                <span>Carregando detalhes do lote...</span>
            </div>
        `;
        modal.classList.add('show');

        try {
            const res = await fetch(`/api/hygiene_history/${encodeURIComponent(logId)}`);
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload.error || 'Falha ao carregar o lote.');

            const clients = payload.clients || [];
            const totalCardsLabel = Number(payload.total_success || clients.length || 0).toLocaleString('pt-BR');
            if (exportBtn) {
                exportBtn.disabled = false;
                exportBtn.dataset.logId = logId;
                exportBtn.onclick = () => downloadFileFromUrl(
                    `/api/hygiene_history/${encodeURIComponent(logId)}/export`,
                    exportBtn,
                    '<i class="fa-solid fa-file-excel"></i> Exportar XLSX',
                    '<i class="fa-solid fa-spinner fa-spin"></i> Exportando...'
                );
            }
            subtitle.textContent = `${payload.created_at || '-'} • ${Number(payload.total_success || clients.length || 0).toLocaleString('pt-BR')} cartão(ões)`;
            const rowsHtml = clients.length
                ? clients.map(client => `
                    <tr>
                        <td data-label="Nome"><span class="hygiene-history-detail-client-name">${escapeHtml(client.nome || '-')}</span></td>
                        <td data-label="CPF">${escapeHtml(formatCpfBR(client.cpf))}</td>
                        <td data-label="Cartão"><span class="hygiene-history-detail-card-number">${escapeHtml(client.cartao || '-')}</span></td>
                        <td data-label="Observação"><span class="hygiene-history-detail-note-text" title="${escapeHtml(client.note || '-')}">${escapeHtml(client.note || '-')}</span></td>
                    </tr>
                `).join('')
                : '<tr><td colspan="4" class="text-center text-muted py-5">Nenhum detalhe de cliente salvo neste lote.</td></tr>';

            content.innerHTML = `
                <div class="hygiene-history-detail-summary">
                    <div><span>Operador</span><strong>${escapeHtml(payload.username || 'Desconhecido')}</strong></div>
                    <div><span>AdminPanel</span><strong>${escapeHtml(payload.adminpanel_username || '-')}</strong></div>
                    <div><span>Quantidade</span><strong>${Number(payload.total_success || 0).toLocaleString('pt-BR')}</strong></div>
                </div>
                <div class="hygiene-history-detail-note">
                    <span>Observação</span>
                    <strong>${escapeHtml(payload.observation || 'Sem observação')}</strong>
                </div>
                <div class="hygiene-history-detail-note">
                    <span>Filtro utilizado</span>
                    <strong>${escapeHtml(payload.filter_summary || 'Filtro não registrado')}</strong>
                </div>
                <div class="table-responsive hygiene-history-detail-table">
                    <table class="modern-table">
                        <thead>
                            <tr>
                                <th>Nome</th>
                                <th>CPF</th>
                                <th>Cartão</th>
                                <th>Observação automática</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            `;
            subtitle.textContent = `${payload.created_at || '-'} \u2022 ${totalCardsLabel} cart\u00e3o(\u00f5es)`;
            const detailLabels = content.querySelectorAll('.hygiene-history-detail-note span');
            if (detailLabels[0]) detailLabels[0].textContent = 'Observação';
            const detailValues = content.querySelectorAll('.hygiene-history-detail-note strong');
            if (detailValues[0]) detailValues[0].textContent = payload.observation || 'Sem observação';
            if (detailValues[1]) detailValues[1].textContent = payload.filter_summary || 'Filtro não registrado';
            const tableHeaders = content.querySelectorAll('.hygiene-history-detail-table th');
            if (tableHeaders[2]) tableHeaders[2].textContent = 'Cartão';
            if (tableHeaders[3]) tableHeaders[3].textContent = 'Observação automática';
        } catch (error) {
            content.innerHTML = `<div class="card-usage-empty"><i class="fa-regular fa-circle-xmark"></i><strong>Não foi possível carregar</strong><span>${escapeHtml(error.message)}</span></div>`;
        }
    }

    // ── Jobs Monitor (admin only) ─────────────────────────────────────────────
    let _jobsPollingTimer = null;
    let _jobsMonitorCollapsed = false;

    window.toggleJobsMonitor = function() {
        if (!currentUser || currentUser.is_admin !== true) {
            stopJobsPolling(true);
            return;
        }
        _jobsMonitorCollapsed = !_jobsMonitorCollapsed;
        const cards  = document.getElementById('hjm-cards');
        const btn    = document.getElementById('hjm-toggle');
        const dot    = document.querySelector('.hjm-live-dot');
        if (_jobsMonitorCollapsed) {
            if (cards) cards.classList.add('hidden');
            if (btn)   { btn.title = 'Expandir painel'; btn.innerHTML = '<i class="fa-solid fa-chevron-down"></i> Expandir'; }
            if (dot)   dot.style.animationPlayState = 'paused';
            stopJobsPolling(false);
        } else {
            if (cards) cards.classList.remove('hidden');
            if (btn)   { btn.title = 'Recolher painel'; btn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Recolher'; }
            if (dot)   dot.style.animationPlayState = '';
            loadRunningJobs();
            _jobsPollingTimer = setInterval(loadRunningJobs, 5000);
        }
    };

    async function loadRunningJobs() {
        if (!currentUser || currentUser.is_admin !== true) {
            stopJobsPolling(true);
            return;
        }
        const monitor = document.getElementById('hygiene-jobs-monitor');
        if (!monitor) return;
        try {
            const res = await fetch('/api/admin/hygiene_jobs');
            if (!res.ok) return;
            const data = await res.json();
            renderJobsMonitor(data.jobs || []);
        } catch (_) {}
    }

    function renderJobsMonitor(jobs) {
        if (!currentUser || currentUser.is_admin !== true) {
            stopJobsPolling(true);
            return;
        }
        const monitor = document.getElementById('hygiene-jobs-monitor');
        const cards   = document.getElementById('hjm-cards');
        const badge   = document.getElementById('hjm-count');
        if (!monitor || !cards) return;

        monitor.classList.remove('hidden');
        badge.textContent = jobs.length;

        if (jobs.length === 0) {
            cards.innerHTML = '<div class="hjm-empty"><i class="fa-solid fa-check-circle" style="color:#34D399;margin-right:6px;"></i>Nenhum job em execução no momento.</div>';
            return;
        }

        const STATUS_META = {
            queued:           { label: 'Na fila',    color: '#F59E0B', icon: 'fa-clock' },
            running:          { label: 'Executando', color: '#22C55E', icon: 'fa-circle-play' },
            cancel_requested: { label: 'Cancelando', color: '#EF4444', icon: 'fa-ban' },
        };

        cards.innerHTML = jobs.map(j => {
            const meta = STATUS_META[j.status] || { label: j.status, color: '#94A3B8', icon: 'fa-circle' };
            const pct  = j.progress_percent || 0;
            const proc = (j.processed || 0).toLocaleString('pt-BR');
            const tot  = (j.total || 0).toLocaleString('pt-BR');
            const startedStr = j.started_at ? j.started_at.replace('T', ' ').slice(0, 16) : '—';
            const cardCell = j.current_card
                ? `<div class="hjm-detail-item"><i class="fa-solid fa-credit-card"></i> <span>${j.current_card}</span></div>` : '';
            const cpfCell = j.current_cpf
                ? `<div class="hjm-detail-item"><i class="fa-solid fa-id-card"></i> <span>${j.current_cpf}</span></div>` : '';
            return `
            <div class="hjm-card">
                <div class="hjm-card-top">
                    <div class="hjm-user-block">
                        <div class="hjm-avatar">${(j.username || '?')[0].toUpperCase()}</div>
                        <div>
                            <div class="hjm-username">${j.username || '—'}</div>
                            <div class="hjm-started">Iniciado em ${startedStr}</div>
                        </div>
                    </div>
                    <span class="hjm-status-pill" style="background:${meta.color}20;color:${meta.color};border-color:${meta.color}40;">
                        <i class="fa-solid ${meta.icon}"></i> ${meta.label}
                    </span>
                </div>
                <div class="hjm-label">${j.progress_label || '—'}</div>
                <div class="hjm-progress-bar-wrap">
                    <div class="hjm-progress-bar" style="width:${pct}%;background:${meta.color};"></div>
                </div>
                <div class="hjm-progress-foot">
                    <span class="hjm-progress-pct">${pct}%</span>
                    <span class="hjm-progress-count">${proc} / ${tot} cartões</span>
                </div>
                ${cardCell || cpfCell ? `<div class="hjm-details">${cardCell}${cpfCell}</div>` : ''}
                ${j.progress_detail ? `<div class="hjm-detail-text">${j.progress_detail}</div>` : ''}
            </div>`;
        }).join('');
    }

    function startJobsPolling() {
        if (!currentUser || currentUser.is_admin !== true) {
            stopJobsPolling(true);
            return;
        }
        stopJobsPolling();
        // Mostrar painel imediatamente com estado carregando
        const monitor = document.getElementById('hygiene-jobs-monitor');
        const cards   = document.getElementById('hjm-cards');
        if (monitor) monitor.classList.remove('hidden');
        if (cards) cards.innerHTML = '<div class="hjm-empty"><i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Verificando jobs...</div>';
        loadRunningJobs();
        _jobsPollingTimer = setInterval(loadRunningJobs, 5000);
    }

    function stopJobsPolling(hidePanel = true) {
        if (_jobsPollingTimer) { clearInterval(_jobsPollingTimer); _jobsPollingTimer = null; }
        if (hidePanel) {
            const monitor = document.getElementById('hygiene-jobs-monitor');
            if (monitor) monitor.classList.add('hidden');
            _jobsMonitorCollapsed = false;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    function initHygieneHistoryView() {
        if (!currentUser || (currentUser.is_admin !== true && currentUser.permissions?.higienizacao !== true)) return;
        if (!hygieneHistoryInitialized) {
            document.getElementById('btn-hygiene-history-filter')?.addEventListener('click', () => {
                hygieneHistoryPage = 1;
                loadHygieneHistory();
            });
            document.getElementById('btn-hygiene-history-clear')?.addEventListener('click', () => {
                hygieneHistoryRules = [{ field: 'created_at', operator: 'after', value: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) }];
                hygieneHistoryPage = 1;
                renderHygieneHistoryBuilder();
                loadHygieneHistory();
            });
            document.getElementById('hygiene-history-page-size')?.addEventListener('change', () => {
                hygieneHistoryPage = 1;
                loadHygieneHistory();
            });
            document.getElementById('hygiene-history-prev-page')?.addEventListener('click', () => {
                if (hygieneHistoryPage <= 1) return;
                hygieneHistoryPage -= 1;
                loadHygieneHistory();
            });
            document.getElementById('hygiene-history-next-page')?.addEventListener('click', () => {
                if (hygieneHistoryTotalPages && hygieneHistoryPage >= hygieneHistoryTotalPages) return;
                hygieneHistoryPage += 1;
                loadHygieneHistory();
            });
            hygieneHistoryInitialized = true;
        }
        renderHygieneHistoryBuilder();
        loadHygieneHistory();
        if (currentUser?.is_admin === true) {
            startJobsPolling();
        } else {
            stopJobsPolling(true);
        }
    }

    async function downloadFileFromUrl(url, button, idleHtml, loadingHtml) {
        if (!button || button.dataset.loading === 'true') return;

        button.dataset.loading = 'true';
        button.disabled = true;
        if (loadingHtml) button.innerHTML = loadingHtml;

        try {
            const response = await fetch(url, { credentials: 'same-origin' });
            if (!response.ok) {
                let message = `Erro ao exportar (${response.status})`;
                try {
                    const payload = await response.json();
                    if (payload && payload.error) message = payload.error;
                } catch (e) { }
                throw new Error(message);
            }

            const blob = await response.blob();
            const disposition = response.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i);
            const filename = decodeURIComponent((match && (match[1] || match[2])) || 'exportacao.xlsx');

            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(blobUrl);
        } catch (error) {
            console.error(error);
            alert(error.message || 'Nao foi possivel concluir a exportacao.');
        } finally {
            button.dataset.loading = 'false';
            button.disabled = false;
            if (idleHtml) button.innerHTML = idleHtml;
        }
    }

    // Export button handler
    const btnExportAttention = document.getElementById('btn-export-attention');
    if (btnExportAttention) {
        const idleHtml = btnExportAttention.innerHTML;
        btnExportAttention.addEventListener('click', async () => {
            await downloadFileFromUrl(
                '/api/attention_users/export',
                btnExportAttention,
                idleHtml,
                '<i class="fa-solid fa-spinner fa-spin"></i> Exportando...'
            );
        });
    }

    // Tab switching
    document.querySelectorAll('.dash-panel-tab').forEach(btn => {
        btn.addEventListener('click', () => activateDashboardTab(btn.dataset.tab));
    });

    const btnExportHygieneDashboard = document.getElementById('btn-export-hygiene-dashboard');
    if (btnExportHygieneDashboard) {
        const idleHtml = btnExportHygieneDashboard.innerHTML;
        btnExportHygieneDashboard.addEventListener('click', async () => {
            await downloadFileFromUrl(
                '/api/hygiene_dashboard/export',
                btnExportHygieneDashboard,
                idleHtml,
                '<i class="fa-solid fa-spinner fa-spin"></i> Exportando...'
            );
        });
    }


    // --- QUOTA MONITORING LOGIC ---
    const QUOTA_MONTH_NAMES = ['', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const QUOTA_MONTH_FULL = ['', 'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const QUOTA_APPLICATIONS = {
        400: 'Vale Transporte',
        500: 'Comum',
        505: 'P Social',
        910: 'Escolar'
    };
    let quotaCache = null;
    let quotaSelectedMonths = new Set();
    let quotaSelectedYears = new Set();
    let quotaDailyChartInstance = null;
    let quotaUserChartInstance = null;
    let quotaUsersMap = new Map();
    let quotaLimitValue = 150;
    let quotaTransactionProfile = 'all';
    let quotaApplicationId = 910;
    let quotaFetchController = null;
    let quotaDailyFetchController = null;
    let quotaRequestSerial = 0;

    const quotaNow = new Date();
    quotaSelectedMonths = new Set([quotaNow.getMonth() + 1]);
    quotaSelectedYears = new Set([quotaNow.getFullYear()]);

    function quotaFormatCurrency(value) {
        const num = Number(value || 0);
        return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num);
    }

    function quotaGetInitials(name) {
        if (!name) return 'QT';
        const parts = name.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }

    function quotaFormatDateTime(isoStr) {
        if (!isoStr) return '-';
        const d = new Date(isoStr);
        if (Number.isNaN(d.getTime())) return isoStr;
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${mins}`;
    }

    function quotaNormalizeNumber(value) {
        return Number(value || 0);
    }

    function quotaReadCount(value, fallback = 0) {
        return value === undefined || value === null || value === '' ? Number(fallback || 0) : Number(value);
    }

    function quotaGetSelectedPeriodKeys() {
        const keys = [];
        quotaSelectedYears.forEach(year => {
            quotaSelectedMonths.forEach(month => {
                keys.push(`${String(month).padStart(2, '0')}-${year}`);
            });
        });
        return keys;
    }

    function quotaGetApplicationLabel(applicationId = quotaApplicationId) {
        return QUOTA_APPLICATIONS[Number(applicationId)] || 'Escolar';
    }

    function quotaGetTransactionProfileLabel(profile) {
        if (profile === 'purchase_only') return 'compras';
        if (profile === 'transfer_only') return 'transferencia';
        if (profile === 'admin_only') return 'lanc. adm.';
        if (profile === 'mixed_only') return 'compras + transferencia';
        return 'ambas';
    }

    function renderQuotaYearChips(years) {
        const container = document.getElementById('quota-year-chips');
        if (!container) return;
        container.innerHTML = years.map(year => `<div class="quota-filter-chip" data-year="${year}">${year}</div>`).join('');
        container.querySelectorAll('.quota-filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const year = parseInt(chip.dataset.year, 10);
                quotaSelectedYears = new Set([year]);
                syncQuotaChipState();
                debouncedLoadQuotaPanel();
            });
        });
    }

    function renderQuotaYearChipsFallback() {
        const now = new Date();
        renderQuotaYearChips([now.getFullYear() - 1, now.getFullYear()]);
        syncQuotaChipState();
    }

    function applyQuotaSelectedPeriods(selectedPeriods) {
        if (!selectedPeriods || selectedPeriods.length === 0) return;
        quotaSelectedMonths = new Set();
        quotaSelectedYears = new Set();

        selectedPeriods.forEach(periodKey => {
            const [monthStr, yearStr] = String(periodKey).split('-');
            const month = parseInt(monthStr, 10);
            const year = parseInt(yearStr, 10);
            if (!Number.isNaN(month)) quotaSelectedMonths.add(month);
            if (!Number.isNaN(year)) quotaSelectedYears.add(year);
        });
    }

    function syncQuotaChipState() {
        document.querySelectorAll('#quota-month-chips .quota-filter-chip').forEach(chip => {
            const month = parseInt(chip.dataset.month, 10);
            chip.classList.toggle('active', quotaSelectedMonths.has(month));
        });
        document.querySelectorAll('#quota-year-chips .quota-filter-chip').forEach(chip => {
            const year = parseInt(chip.dataset.year, 10);
            chip.classList.toggle('active', quotaSelectedYears.has(year));
        });
        document.querySelectorAll('#quota-transaction-profile-chips .quota-filter-chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.profile === quotaTransactionProfile);
        });
        document.querySelectorAll('#quota-application-chips .quota-filter-chip').forEach(chip => {
            chip.classList.toggle('active', Number(chip.dataset.applicationId) === Number(quotaApplicationId));
        });
    }

    function ensureQuotaDefaultSelection(availablePeriods) {
        if (!availablePeriods || availablePeriods.length === 0) return;

        const availableMonths = new Set(availablePeriods.map(p => Number(p.month)));
        const availableYears = new Set(availablePeriods.map(p => Number(p.year)));
        const currentDate = new Date();
        const currentMonth = currentDate.getMonth() + 1;
        const currentYear = currentDate.getFullYear();

        if (quotaSelectedYears.size === 0) {
            quotaSelectedYears.add(availableYears.has(currentYear) ? currentYear : Math.max(...availableYears));
        } else {
            quotaSelectedYears = new Set([...quotaSelectedYears].filter(year => availableYears.has(year)));
            if (quotaSelectedYears.size === 0) quotaSelectedYears.add(Math.max(...availableYears));
        }

        if (quotaSelectedMonths.size === 0) {
            quotaSelectedMonths.add(availableMonths.has(currentMonth) ? currentMonth : Math.max(...availableMonths));
        } else {
            quotaSelectedMonths = new Set([...quotaSelectedMonths].filter(month => availableMonths.has(month)));
            if (quotaSelectedMonths.size === 0) quotaSelectedMonths.add(Math.max(...availableMonths));
        }
    }

    function buildQuotaUsersMap(data, limitValue) {
        const map = new Map();
        data.forEach(item => {
            const key = String(item.user_id || item.usr_id || item.cpf || item.usr_name || Math.random());
            if (!map.has(key)) {
                map.set(key, {
                    key,
                    user_id: Number(item.user_id || item.usr_id || 0),
                    name: item.usr_name || 'Nao informado',
                    cpf: item.cpf || '',
                    card: item.cartao_principal || item.cartao || '',
                    cardCount: quotaReadCount(item.qtd_cartoes),
                    totalMonthly: quotaNormalizeNumber(item.total_comprado),
                    transactionCount: quotaReadCount(item.qtd_transacoes, item.qtd_compras),
                    purchaseCount: quotaReadCount(item.qtd_compras),
                    actualPurchaseCount: quotaReadCount(item.qtd_compras_reais, item.qtd_compras),
                    transferCount: quotaReadCount(item.qtd_transferencias),
                    adminCount: quotaReadCount(item.qtd_lancamentos_adm),
                    periodCount: quotaReadCount(item.qtd_periodos),
                    excessTotal: quotaNormalizeNumber(item.total_excedente),
                    classificationSummary: item.classificacao_resumo || '',
                    onlyTransfers: Boolean(item.somente_transferencias),
                    transactions: []
                });
            }
        });
        return map;
    }

    function quotaBuildUserCountLabel(user) {
        const purchases = Number(user.actualPurchaseCount || 0);
        const transfers = Number(user.transferCount || 0);
        const admin = Number(user.adminCount || 0);
        const total = purchases + transfers;

        if (admin > 0 && total === 0) {
            return `${admin} lanc. adm.`;
        }

        if (transfers > 0 && purchases === 0) {
            return `${total} transfer${total === 1 ? 'encia' : 'encias'}`;
        }
        if (transfers > 0) {
            return `${purchases} compra${purchases === 1 ? '' : 's'} / ${transfers} transfer${transfers === 1 ? 'encia' : 'encias'}`;
        }
        return `${purchases} compra${purchases === 1 ? '' : 's'}`;
    }

    function quotaBuildUserSecondaryLabel(user) {
        const purchases = Number(user.actualPurchaseCount || 0);
        const transfers = Number(user.transferCount || 0);
        const admin = Number(user.adminCount || 0);
        if (transfers > 0 && purchases === 0 && admin === 0) return 'Somente transferencia de credito';
        if (transfers > 0) return 'Possui compras e transferencias';
        return '';
    }

    function quotaTypeBadge(typeKey, typeLabel) {
        const isTransfer = typeKey === 'transferencia';
        const cssClass = isTransfer ? 'transfer' : 'purchase';
        const label = typeLabel || (isTransfer ? 'Transferencia de Credito' : 'Compra');
        return `<span class="quota-type-badge ${cssClass}">${label}</span>`;
    }

    function quotaStatusBadge(statusKey, statusLabel) {
        if (statusKey !== 'R') return '';
        return `<span class="quota-type-badge admin">${statusLabel || 'Lancamento Administrativo'}</span>`;
    }

    async function loadQuotaPanel() {
        try {
            quotaRequestSerial += 1;
            const requestSerial = quotaRequestSerial;
            const statusBadge = document.getElementById('quota-status-badge');
            if (statusBadge) {
                statusBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Consultando...</span>';
            }
            
            const contentGrid = document.querySelector('.quota-content-grid');
            const globalLoader = document.getElementById('quota-global-loader');
            
            if (contentGrid && globalLoader) {
                contentGrid.style.display = 'none';
                globalLoader.classList.remove('hidden');
                
                // Reset loader state visually
                const bar = document.getElementById('quota-progress-bar');
                const pct = document.getElementById('quota-progress-pct');
                const msg = document.getElementById('quota-progress-msg');
                if (bar) bar.style.width = '0%';
                if (pct) pct.textContent = '0%';
                if (msg) msg.textContent = 'Iniciando consulta...';
                
                // Animate progress up to 95%
                let currentPct = 0;
                if (window._quotaProgressInterval) clearInterval(window._quotaProgressInterval);
                window._quotaProgressInterval = setInterval(() => {
                    const diff = Math.random() * 8 + 2; // + 2 to 10%
                    if (currentPct + diff < 95) {
                        currentPct += diff;
                        if (bar) bar.style.width = currentPct + '%';
                        if (pct) pct.textContent = Math.round(currentPct) + '%';
                        if (msg && currentPct > 30) msg.textContent = 'Extraindo sumarização...';
                        if (msg && currentPct > 70) msg.textContent = 'Consolidando dados...';
                    }
                }, 350);
            }
            
            const periods = quotaGetSelectedPeriodKeys();
            const params = new URLSearchParams();
            if (periods.length > 0) params.set('periods', periods.join(','));
            params.set('limit', String(quotaLimitValue || 150));
            params.set('transaction_profile', quotaTransactionProfile);
            params.set('application_id', String(quotaApplicationId || 910));

            if (quotaFetchController) quotaFetchController.abort();
            quotaFetchController = new AbortController();
            if (quotaDailyFetchController) quotaDailyFetchController.abort();

            const res = await fetch(`/api/quota_monitoring?${params.toString()}`, {
                signal: quotaFetchController.signal
            });
            const data = await res.json();

            if (data.error) {
                if (window._quotaProgressInterval) clearInterval(window._quotaProgressInterval);
                if (contentGrid && globalLoader) {
                    globalLoader.classList.add('hidden');
                    contentGrid.style.display = '';
                }
                console.error('Quota panel error:', data.error);
                const rankingContainer = document.getElementById('quota-ranking-list');
                if (rankingContainer) {
                    rankingContainer.innerHTML = `<div class="quota-empty-state text-danger">Erro: ${data.error}</div>`;
                }
                return;
            }

            quotaCache = data;
            const availablePeriods = data.available_periods || [];
            const availableYears = [...new Set(availablePeriods.map(p => Number(p.year)))].sort((a, b) => a - b);

            renderQuotaYearChips(availableYears);
            applyQuotaSelectedPeriods(data.selected_periods || []);

            document.querySelectorAll('#quota-month-chips .quota-filter-chip').forEach(chip => {
                if (chip.dataset.bound === 'true') return;
                chip.dataset.bound = 'true';
                chip.addEventListener('click', () => {
                    const month = parseInt(chip.dataset.month, 10);
                    quotaSelectedMonths = new Set([month]);
                    syncQuotaChipState();
                    debouncedLoadQuotaPanel();
                });
            });

            ensureQuotaDefaultSelection(availablePeriods);

            quotaLimitValue = quotaNormalizeNumber(data.limit || 150);
            quotaTransactionProfile = data.transaction_profile || quotaTransactionProfile || 'all';
            quotaApplicationId = Number(data.application_id || quotaApplicationId || 910);
            syncQuotaChipState();
            const limitInput = document.getElementById('quota-limit-input');
            if (limitInput && document.activeElement !== limitInput) {
                limitInput.value = String(Math.round(quotaLimitValue));
            }

            const banner = document.getElementById('quota-updated-banner');
            if (banner && data.last_updated) {
                const origem = data.cache_hit ? 'Resposta otimizada' : 'Consulta realizada';
                banner.innerHTML = `<i class="fa-regular fa-clock"></i> <span>${origem} em: <strong>${data.last_updated}</strong> • Limite atual: <strong>R$ ${quotaLimitValue.toFixed(2).replace('.', ',')}</strong></span>`;
            }

            if (statusBadge) {
                statusBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>Consulta sob demanda</span>';
            }

            renderQuotaFromResponse(data);
            loadQuotaDailyData(data.selected_periods || periods, quotaLimitValue, requestSerial);

            // Agora sim - as duas requisições voltaram (Sumário + Gráfico Diário).
            // Podemos finalizar a barra de progresso.
            if (window._quotaProgressInterval) clearInterval(window._quotaProgressInterval);
            const _bar = document.getElementById('quota-progress-bar');
            const _pct = document.getElementById('quota-progress-pct');
            const _msg = document.getElementById('quota-progress-msg');
            if (_bar) _bar.style.width = '100%';
            if (_pct) _pct.textContent = '100%';
            if (_msg) _msg.textContent = 'Concluído!';
            
            await new Promise(r => setTimeout(r, 50));
            
            if (contentGrid && globalLoader) {
                globalLoader.classList.add('hidden');
                contentGrid.style.display = '';
            }

        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('Quota panel fetch error:', e);
            if (window._quotaProgressInterval) clearInterval(window._quotaProgressInterval);
            
            const contentGrid = document.querySelector('.quota-content-grid');
            const globalLoader = document.getElementById('quota-global-loader');
            if (contentGrid && globalLoader) {
                globalLoader.classList.add('hidden');
                contentGrid.style.display = '';
            }

            const statusBadge = document.getElementById('quota-status-badge');
            if (statusBadge) {
                statusBadge.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i><span>Falha na consulta</span>';
            }
        }
    }

    function renderQuotaFromResponse(payload) {
        const rankingContainer = document.getElementById('quota-ranking-list');
        if (!payload || !rankingContainer) return;

        const rankingData = payload.ranking || [];
        const limitValue = quotaNormalizeNumber(payload.limit || 150);

        quotaUsersMap = buildQuotaUsersMap(rankingData, limitValue);
        const users = [...quotaUsersMap.values()].sort((a, b) => b.totalMonthly - a.totalMonthly);

        document.getElementById('quota-total-users').textContent = quotaNormalizeNumber(payload.totals?.users).toLocaleString('pt-BR');
        document.getElementById('quota-total-value').textContent = quotaFormatCurrency(payload.totals?.value || 0);
        document.getElementById('quota-total-transactions').textContent = quotaNormalizeNumber(payload.totals?.transactions).toLocaleString('pt-BR');

        const monthLabels = [...quotaSelectedMonths].sort((a, b) => a - b).map(month => QUOTA_MONTH_FULL[month]);
        const yearLabels = [...quotaSelectedYears].sort((a, b) => a - b);
        const subtitle = document.getElementById('quota-subtitle');
        const profileLabel = quotaGetTransactionProfileLabel(quotaTransactionProfile);
        const applicationLabel = quotaGetApplicationLabel(payload.application_id);
        if (subtitle) {
            subtitle.textContent = monthLabels.length > 0
                ? `Clientes do ${applicationLabel} que excederam o limite de R$ ${limitValue.toFixed(2).replace('.', ',')} em ${monthLabels.join(', ')} ${yearLabels.join('/')} com filtro ${profileLabel}.`
                : `Clientes do ${applicationLabel} que excederam o limite de R$ ${limitValue.toFixed(2).replace('.', ',')} no per?odo selecionado com filtro ${profileLabel}.`;
        }

        const chartSubtitle = document.getElementById('quota-chart-subtitle');
        if (chartSubtitle) {
            chartSubtitle.textContent = monthLabels.length > 0
                ? `Volume de recargas por dia (${monthLabels.map(month => month.slice(0, 3)).join(', ')} ${yearLabels.join('/')})`
                : 'Volume de recargas por dia';
        }

        renderQuotaRanking(users, limitValue);
        renderQuotaDailyChart([]);
    }

    async function loadQuotaDailyData(periods, limitValue, requestSerial) {
        try {
            const params = new URLSearchParams();
            if (periods.length > 0) params.set('periods', periods.join(','));
            params.set('limit', String(limitValue || 150));
            params.set('transaction_profile', quotaTransactionProfile);
            params.set('application_id', String(quotaApplicationId || 910));

            quotaDailyFetchController = new AbortController();
            const res = await fetch(`/api/quota_monitoring/daily?${params.toString()}`, {
                signal: quotaDailyFetchController.signal
            });
            const data = await res.json();
            if (data.error) {
                console.error('Quota daily chart error:', data.error);
                return;
            }
            if (requestSerial !== quotaRequestSerial) return;

            renderQuotaDailyChart(data.daily || []);

            const monthLabels = [...quotaSelectedMonths].sort((a, b) => a - b).map(month => QUOTA_MONTH_FULL[month]);
            const yearLabels = [...quotaSelectedYears].sort((a, b) => a - b);
            const chartSubtitle = document.getElementById('quota-chart-subtitle');
            if (chartSubtitle) {
                chartSubtitle.textContent = monthLabels.length > 0
                    ? `Volume de recargas por dia (${monthLabels.map(month => month.slice(0, 3)).join(', ')} ${yearLabels.join('/')})`
                    : 'Volume de recargas por dia';
            }
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('Quota daily chart fetch error:', e);
        }
    }

    function renderQuotaRanking(users, limitValue) {
        const container = document.getElementById('quota-ranking-list');
        if (!container) return;

        if (!users || users.length === 0) {
            container.innerHTML = `<div class="quota-empty-state">Nenhum cliente excedeu R$ ${limitValue.toFixed(2).replace('.', ',')} no per?odo selecionado.</div>`;
            return;
        }

        const maxValue = users[0].totalMonthly || 1;
        container.innerHTML = users.map((user, index) => {
            const posClass = index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : '';
            const barWidth = Math.max(Math.round((user.totalMonthly / maxValue) * 100), 4);
            const cardLabel = user.card
                ? `Cartao: ${user.card}${user.cardCount > 1 ? ` (+${user.cardCount - 1})` : ''}`
                : 'Cartao nao informado';
            return `
                <div class="quota-ranking-item" data-user-key="${user.key}">
                    <div class="quota-ranking-position ${posClass}">${index + 1}</div>
                    <div class="quota-ranking-avatar">${quotaGetInitials(user.name)}</div>
                    <div class="quota-ranking-info">
                        <div class="quota-ranking-name">${user.name}</div>
                        <div class="quota-ranking-cpf"><i class="fa-regular fa-id-card"></i> ${user.cpf || 'CPF nao informado'}</div>
                        <div class="quota-ranking-card"><i class="fa-regular fa-credit-card"></i> ${cardLabel}</div>
                    </div>
                    <div class="quota-ranking-stats">
                        <span class="quota-ranking-count">${quotaBuildUserCountLabel(user)}</span>
                        ${user.adminCount > 0 ? `<span class="quota-ranking-admin">${user.adminCount} lanc. adm.</span>` : ''}
                        ${user.onlyTransfers
                            ? '<span class="quota-ranking-warning">Somente transferencia</span>'
                            : (user.transferCount > 0 ? '<span class="quota-ranking-mixed">Compras e transferencias</span>' : '')}
                    </div>
                    <div class="quota-ranking-value">
                        <div class="amount">${quotaFormatCurrency(user.totalMonthly)}</div>
                        <div class="excess-badge">+${quotaFormatCurrency(user.excessTotal)} excedente</div>
                        <div class="bar-mini" style="width:${barWidth}px;"></div>
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.quota-ranking-item').forEach(item => {
            item.addEventListener('click', () => showQuotaUserDetails(item.dataset.userKey, limitValue));
        });

        applyQuotaSearchFilter();
    }

    function renderQuotaDailyChart(data) {
        const canvas = document.getElementById('quota-daily-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        if (quotaDailyChartInstance) quotaDailyChartInstance.destroy();

        const dailyData = (data || [])
            .map(item => [item.date, quotaNormalizeNumber(item.total)])
            .sort((a, b) => new Date(a[0]) - new Date(b[0]));
        if (dailyData.length === 0) {
            quotaDailyChartInstance = null;
            return;
        }

        const labels = dailyData.map(([date]) => {
            const [year, month, day] = date.split('-');
            return `${day}/${month}`;
        });

        const gradient = ctx.createLinearGradient(0, 0, 0, 320);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.45)');
        gradient.addColorStop(1, 'rgba(6, 182, 212, 0.04)');

        quotaDailyChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Volume diario (R$)',
                    data: dailyData.map(([, total]) => Number(total.toFixed(2))),
                    borderColor: '#38BDF8',
                    backgroundColor: gradient,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.35,
                    pointBackgroundColor: '#0B0E14',
                    pointBorderColor: '#38BDF8',
                    pointBorderWidth: 2,
                    pointRadius: 3,
                    pointHoverRadius: 5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(12, 16, 22, 0.95)',
                        titleColor: '#38BDF8',
                        bodyColor: '#fff',
                        padding: 12,
                        callbacks: {
                            label: ctx => quotaFormatCurrency(ctx.raw)
                        }
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#6B7280', font: { size: 10 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#6B7280', font: { size: 10 } } }
                }
            }
        });
    }

    function applyQuotaSearchFilter() {
        const input = document.getElementById('quota-search-input');
        if (!input) return;
        const query = input.value.toLowerCase();
        document.querySelectorAll('.quota-ranking-item').forEach(item => {
            const name = item.querySelector('.quota-ranking-name')?.textContent.toLowerCase() || '';
            const cpf = item.querySelector('.quota-ranking-cpf')?.textContent.toLowerCase() || '';
            const card = item.querySelector('.quota-ranking-card')?.textContent.toLowerCase() || '';
            item.style.display = (name.includes(query) || cpf.includes(query) || card.includes(query)) ? 'flex' : 'none';
        });
    }

    const quotaSearchInput = document.getElementById('quota-search-input');
    if (quotaSearchInput) {
        quotaSearchInput.addEventListener('input', applyQuotaSearchFilter);
    }

    async function showQuotaUserDetails(userKey, limitValue, detailsProfile = quotaTransactionProfile) {
        const user = quotaUsersMap.get(userKey);
        if (!user) return;

        const modal = document.getElementById('quota-modal');
        const periods = quotaGetSelectedPeriodKeys();
        const params = new URLSearchParams();
        if (periods.length > 0) params.set('periods', periods.join(','));
        params.set('limit', String(limitValue || quotaLimitValue || 150));
        params.set('user_id', String(user.user_id));
        params.set('application_id', String(quotaApplicationId || 910));
        params.set('transaction_profile', detailsProfile || 'all');

        const tbody = document.getElementById('quota-modal-table-body');
        document.getElementById('quota-modal-avatar').textContent = quotaGetInitials(user.name);
        document.getElementById('quota-modal-user-name').textContent = user.name;
        document.getElementById('quota-modal-user-cpf').textContent = `CPF: ${user.cpf || 'Nao informado'}`;
        document.getElementById('quota-modal-user-card').textContent = 'Cartao: carregando...';
        document.getElementById('quota-modal-user-periods').textContent = periods.length > 0
            ? `Aplicacao: ${quotaGetApplicationLabel()} • Periodos: ${periods.join(', ')}`
            : 'Sem periodo identificado';
        document.getElementById('quota-modal-total-user').textContent = quotaFormatCurrency(user.totalMonthly);
        document.getElementById('quota-modal-total-days').textContent = `carregando...`;
        ['purchases', 'transfers', 'admin'].forEach(k => {
             const el = document.getElementById(`quota-modal-metric-${k}`);
             if (el) el.style.display = 'none';
        });
        document.getElementById('quota-modal-excess').textContent = quotaFormatCurrency(user.excessTotal);
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94A3B8;padding:20px;">Carregando detalhes...</td></tr>';

        const ctx = document.getElementById('quota-user-days-chart').getContext('2d');
        if (quotaUserChartInstance) quotaUserChartInstance.destroy();

        modal.classList.remove('hidden');
        modal.classList.add('show');

        try {
            const response = await fetch(`/api/quota_monitoring/user_details?${params.toString()}`);
            const payload = await response.json();
            if (payload.error) throw new Error(payload.error);

            const transactions = payload.data || [];
            const uniqueCards = [...new Set(transactions.map(item => item.cartao).filter(Boolean))];
            document.getElementById('quota-modal-user-card').textContent = uniqueCards.length > 0
                ? `Cartao${uniqueCards.length > 1 ? 's' : ''}: ${uniqueCards.join(' | ')}`
                : 'Cartao: Nao informado';

            let sumPurchases = 0;
            let sumTransfers = 0;
            let sumAdmin = 0;
            let sumCurrent = 0;

            transactions.forEach(item => {
                const val = quotaNormalizeNumber(item.valor_transacao);
                sumCurrent += val;
                if (item.status_movimento_key === 'R') {
                    sumAdmin += val;
                } else if (item.tipo_transacao_key === 'transferencia') {
                    sumTransfers += val;
                } else {
                    sumPurchases += val;
                }
            });
            document.getElementById('quota-modal-total-user').textContent = quotaFormatCurrency(sumCurrent);
            document.getElementById('quota-modal-excess').textContent = quotaFormatCurrency(Math.max(sumCurrent - (limitValue || quotaLimitValue || 150), 0));

            const blockPurchases = document.getElementById('quota-modal-metric-purchases');
            if (blockPurchases) {
                if (sumPurchases > 0) {
                    blockPurchases.style.display = 'flex';
                    document.getElementById('quota-modal-total-purchases').textContent = quotaFormatCurrency(sumPurchases);
                } else {
                    blockPurchases.style.display = 'none';
                }
            }

            const blockTransfers = document.getElementById('quota-modal-metric-transfers');
            if (blockTransfers) {
                if (sumTransfers > 0) {
                    blockTransfers.style.display = 'flex';
                    document.getElementById('quota-modal-total-transfers').textContent = quotaFormatCurrency(sumTransfers);
                } else {
                    blockTransfers.style.display = 'none';
                }
            }

            const blockAdmin = document.getElementById('quota-modal-metric-admin');
            if (blockAdmin) {
                if (sumAdmin > 0) {
                    blockAdmin.style.display = 'flex';
                    document.getElementById('quota-modal-total-admin').textContent = quotaFormatCurrency(sumAdmin);
                } else {
                    blockAdmin.style.display = 'none';
                }
            }

            const uniqueDays = new Set(transactions.map(item => (item.data_hora_compra || '').split('T')[0]).filter(Boolean));
            document.getElementById('quota-modal-total-days').textContent = `${uniqueDays.size} ${uniqueDays.size === 1 ? 'dia' : 'dias'}`;

            const badgesDiv = document.getElementById('quota-modal-user-badges');
            if (badgesDiv) {
                const moreButton = payload.has_more_info
                    ? `<button type="button" class="quota-more-info-btn" id="quota-modal-more-info"><i class="fa-solid fa-layer-group"></i> Ver mais informacoes</button>`
                    : (detailsProfile === 'all' && quotaTransactionProfile !== 'all'
                        ? `<button type="button" class="quota-more-info-btn" id="quota-modal-filter-info"><i class="fa-solid fa-filter"></i> Voltar ao filtro</button>`
                        : '');
                badgesDiv.innerHTML = `
                    <span class="quota-ranking-count" style="font-size:0.8rem; padding:4px 10px;">${quotaBuildUserCountLabel(user)}</span>
                    ${user.adminCount > 0 ? `<span class="quota-ranking-admin" style="font-size:0.8rem; padding:4px 10px;">${user.adminCount} lanc. adm.</span>` : ''}
                    ${user.onlyTransfers
                        ? '<span class="quota-ranking-warning" style="font-size:0.8rem; padding:4px 10px;">Somente transferencia</span>'
                        : (user.transferCount > 0 ? '<span class="quota-ranking-mixed" style="font-size:0.8rem; padding:4px 10px;">Compras e transferencias</span>' : '')}
                    ${moreButton}
                `;
                const moreInfoBtn = document.getElementById('quota-modal-more-info');
                if (moreInfoBtn) {
                    moreInfoBtn.addEventListener('click', () => showQuotaUserDetails(userKey, limitValue, 'all'));
                }
                const filterInfoBtn = document.getElementById('quota-modal-filter-info');
                if (filterInfoBtn) {
                    filterInfoBtn.addEventListener('click', () => showQuotaUserDetails(userKey, limitValue, quotaTransactionProfile));
                }
            }

            tbody.innerHTML = transactions.length > 0
                ? transactions.map(item => `
                    <tr>
                        <td>${quotaFormatDateTime(item.data_hora_compra)}</td>
                        <td>${item.periodo || '-'}</td>
                        <td>
                            ${item.cartao || '-'}
                            ${item.cartao_origem_transferencia ? `<span class="quota-transaction-meta">Origem: ${item.cartao_origem_transferencia}</span>` : ''}
                        </td>
                        <td style="font-weight:700;color:#93C5FD;">
                            <div class="quota-transaction-value">
                                <span>${quotaFormatCurrency(item.valor_transacao)}</span>
                                <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
                                    ${item.status_movimento_key === 'R' ? '' : quotaTypeBadge(item.tipo_transacao_key, item.tipo_transacao)}
                                    ${quotaStatusBadge(item.status_movimento_key, item.status_movimento)}
                                </span>
                            </div>
                        </td>
                    </tr>
                `).join('')
                : '<tr><td colspan="4" style="text-align:center;color:#94A3B8;padding:20px;">Nenhum detalhe encontrado.</td></tr>';

            const totalsByDay = {};
            transactions.forEach(item => {
                const key = (item.data_hora_compra || '').split('T')[0];
                if (!key) return;
                if (!totalsByDay[key]) totalsByDay[key] = { total: 0, count: 0 };
                totalsByDay[key].total += quotaNormalizeNumber(item.valor_transacao);
                totalsByDay[key].count += 1;
            });
            const sortedDays = Object.entries(totalsByDay).sort((a, b) => new Date(a[0]) - new Date(b[0]));
            const labels = sortedDays.map(([date]) => {
                const [year, month, day] = date.split('-');
                return `${day}/${month}`;
            });
            const gradient = ctx.createLinearGradient(0, 0, 0, 220);
            gradient.addColorStop(0, 'rgba(59, 130, 246, 0.7)');
            gradient.addColorStop(1, 'rgba(6, 182, 212, 0.08)');

            quotaUserChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label: 'Valor no dia (R$)',
                        data: sortedDays.map(([, dayData]) => Number(dayData.total.toFixed(2))),
                        backgroundColor: gradient,
                        borderRadius: 6,
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(12, 16, 22, 0.95)',
                            titleColor: '#60A5FA',
                            bodyColor: '#fff',
                            padding: 12,
                            callbacks: {
                                label: function (context) {
                                    const dayData = sortedDays[context.dataIndex][1];
                                    return [
                                        quotaFormatCurrency(context.raw),
                                        `${dayData.count} movimentacao(oes)`
                                    ];
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: '#6B7280', font: { size: 10 } } },
                        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#6B7280', font: { size: 10 } } }
                    }
                }
            });
        } catch (error) {
            console.error(error);
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#F87171;padding:20px;">${error.message || 'Erro ao carregar detalhes.'}</td></tr>`;
            document.getElementById('quota-modal-user-card').textContent = 'Cartao: erro ao carregar';
            document.getElementById('quota-modal-total-days').textContent = 'erro ao carregar';
        }
    }

    const quotaModal = document.getElementById('quota-modal');
    const quotaModalClose = document.getElementById('quota-modal-close');
    if (quotaModalClose && quotaModal) {
        quotaModalClose.addEventListener('click', () => {
            quotaModal.classList.remove('show');
            setTimeout(() => quotaModal.classList.add('hidden'), 200);
        });

        quotaModal.addEventListener('click', (e) => {
            if (e.target === quotaModal) {
                quotaModal.classList.remove('show');
                setTimeout(() => quotaModal.classList.add('hidden'), 200);
            }
        });
    }


    const btnExportQuota = document.getElementById('btn-export-quota');
    if (btnExportQuota) {
        const idleHtml = btnExportQuota.innerHTML;
        btnExportQuota.addEventListener('click', async () => {
            const periods = quotaGetSelectedPeriodKeys();
            const params = new URLSearchParams();
            if (periods.length > 0) params.set('periods', periods.join(','));
            params.set('limit', String(quotaLimitValue || 150));
            params.set('transaction_profile', quotaTransactionProfile);
            params.set('application_id', String(quotaApplicationId || 910));
            const query = `?${params.toString()}`;
            await downloadFileFromUrl(
                `/api/quota_monitoring/export${query}`,
                btnExportQuota,
                idleHtml,
                '<i class="fa-solid fa-spinner fa-spin"></i> Exportando...'
            );
        });
    }

    const quotaLimitInput = document.getElementById('quota-limit-input');
    if (quotaLimitInput) {
        const applyQuotaLimitInput = () => {
            const nextValue = quotaNormalizeNumber(quotaLimitInput.value || 0);
            const normalizedValue = nextValue > 0 ? nextValue : 150;
            const hasChanged = normalizedValue !== quotaLimitValue;

            quotaLimitValue = normalizedValue;
            quotaLimitInput.value = String(Math.round(quotaLimitValue));

            if (hasChanged) {
                loadQuotaPanel();
            }
        };

        quotaLimitInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            applyQuotaLimitInput();
            quotaLimitInput.blur();
        });

        quotaLimitInput.addEventListener('blur', () => {
            applyQuotaLimitInput();
        });
    }

    const debouncedLoadQuotaPanel = debounce(loadQuotaPanel, 400);

    document.querySelectorAll('#quota-transaction-profile-chips .quota-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            quotaTransactionProfile = chip.dataset.profile || 'all';
            syncQuotaChipState();
            debouncedLoadQuotaPanel();
        });
    });

    document.querySelectorAll('#quota-application-chips .quota-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            quotaApplicationId = Number(chip.dataset.applicationId || 910);
            syncQuotaChipState();
            debouncedLoadQuotaPanel();
        });
    });

    renderQuotaYearChipsFallback();


    // --- SINGLE SEARCH LOGIC ---
    const formSingle = document.getElementById('single-search-form');
    const inputCpf = document.getElementById('cpf-input');
    const loaderSingle = document.getElementById('single-search-loader');
    const resultsSingle = document.getElementById('single-search-results');
    let singleSearchController = null;
    let singleSearchTimeout = null;
    let singleSearchRequestSerial = 0;

    function resetSingleSearchLoading() {
        if (singleSearchTimeout) {
            clearTimeout(singleSearchTimeout);
            singleSearchTimeout = null;
        }
        loaderSingle.classList.add('hidden');
    }

    function cancelSingleSearch(clearLoader = true) {
        if (singleSearchController) {
            singleSearchController.abort();
            singleSearchController = null;
        }
        if (clearLoader) resetSingleSearchLoading();
    }

    formSingle.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cpf = inputCpf.value.trim();
        if (!cpf) return;
        singleSearchRequestSerial += 1;
        const requestSerial = singleSearchRequestSerial;

        cancelSingleSearch(false);
        singleSearchController = new AbortController();
        singleSearchTimeout = setTimeout(() => {
            if (singleSearchController) singleSearchController.abort();
        }, 30000);

        resultsSingle.classList.add('hidden');
        loaderSingle.classList.remove('hidden');

        try {
            const res = await fetch('/api/search_cpf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cpf }),
                signal: singleSearchController.signal
            });
            if (requestSerial !== singleSearchRequestSerial) return;
            const data = await res.json();

            if (res.ok) {
                renderSingleResult(data);
            } else {
                resultsSingle.innerHTML = `<div class="glass-panel text-center"><h3 style="color:var(--danger)">${data.error || 'Erro ao buscar.'}</h3></div>`;
                resultsSingle.classList.remove('hidden');
            }
        } catch (error) {
            if (error.name === 'AbortError') return;
            resultsSingle.innerHTML = `<div class="glass-panel text-center"><h3 style="color:var(--danger)">Erro de conexão.</h3></div>`;
            resultsSingle.classList.remove('hidden');
        } finally {
            if (requestSerial === singleSearchRequestSerial) {
                singleSearchController = null;
                resetSingleSearchLoading();
            }
        }
    });

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatMoneyBR(value) {
        const number = Number(value || 0);
        return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function ensureCardUsageModal() {
        let modal = document.getElementById('card-usage-modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'card-usage-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-card glass-panel card-usage-modal-card">
                <div class="card-usage-modal-header">
                    <div style="display:flex;align-items:center;gap:14px;">
                        <div style="width:44px;height:44px;border-radius:10px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <i class="fa-solid fa-credit-card" style="color:#60A5FA;font-size:1.1rem;"></i>
                        </div>
                        <div>
                            <div class="card-usage-title">Usos e Recargas</div>
                            <div class="card-usage-subtitle" id="card-usage-subtitle">Últimos 30 dias</div>
                        </div>
                    </div>
                    <button class="modal-close-btn" type="button" onclick="closeCardUsageModal()" title="Fechar">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div id="card-usage-content" class="card-usage-content"></div>
            </div>
        `;
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeCardUsageModal();
        });
        document.body.appendChild(modal);
        return modal;
    }

    window.closeCardUsageModal = function () {
        const modal = document.getElementById('card-usage-modal');
        if (modal) modal.classList.remove('show');
    };

    window.openCardUsageModal = async function (cardNumber) {
        const card = String(cardNumber || '').trim();
        if (!card) return;

        const modal = ensureCardUsageModal();
        const subtitle = document.getElementById('card-usage-subtitle');
        const content = document.getElementById('card-usage-content');
        subtitle.textContent = `${card} • Últimos 30 dias`;
        content.innerHTML = `
            <div class="card-usage-loading">
                <div class="modern-spinner"></div>
                <span>Consultando movimentações...</span>
            </div>
        `;
        modal.classList.add('show');

        try {
            const res = await fetch(`/api/card_usage?card=${encodeURIComponent(card)}`);
            const payload = await res.json().catch(() => ({}));
            if (!res.ok || payload.result === false) {
                throw new Error(payload.error || 'Não foi possível consultar os usos.');
            }

            const rows = payload.data?.usage || [];
            const noteHtml = payload.note ? `
                <div class="card-usage-note">
                    <i class="fa-solid fa-circle-info"></i>
                    <span>${escapeHtml(payload.note)}</span>
                </div>
            ` : '';
            if (!rows.length) {
                content.innerHTML = `
                    ${noteHtml}
                    <div class="card-usage-empty">
                        <i class="fa-regular fa-folder-open"></i>
                        <strong>Nenhuma movimentação encontrada</strong>
                        <span>Não há usos ou recargas nos últimos 30 dias.</span>
                    </div>
                `;
                return;
            }

            const totalUso = rows.filter(row => Number(row.value) < 0).reduce((sum, row) => sum + Number(row.value || 0), 0);
            const totalRecarga = rows
                .filter(row => Number(row.value) > 0 && String(row.tranType || '').toUpperCase() !== 'RECARGA PENDENTE')
                .reduce((sum, row) => sum + Number(row.value || 0), 0);

            content.innerHTML = `
                ${noteHtml}
                <div class="card-usage-summary">
                    <div class="cu-summary-total">
                        <div class="cu-summary-icon"><i class="fa-solid fa-list-check" style="color:#60A5FA"></i></div>
                        <span class="cu-label">Movimentações</span>
                        <strong class="cu-value" style="color:var(--text-primary)">${rows.length}</strong>
                    </div>
                    <div class="cu-summary-uso">
                        <div class="cu-summary-icon"><i class="fa-solid fa-bus" style="color:#F87171"></i></div>
                        <span class="cu-label">Total de Usos</span>
                        <strong class="cu-value usage-negative">${formatMoneyBR(totalUso)}</strong>
                    </div>
                    <div class="cu-summary-recarga">
                        <div class="cu-summary-icon"><i class="fa-solid fa-money-bill-transfer" style="color:#10B981"></i></div>
                        <span class="cu-label">Total de Recargas</span>
                        <strong class="cu-value usage-positive">${formatMoneyBR(totalRecarga)}</strong>
                    </div>
                </div>
                <div class="card-usage-table-wrap">
                    <table class="card-usage-table">
                        <thead>
                            <tr>
                                <th>Data / Hora</th>
                                <th>Tipo</th>
                                <th>Valor</th>
                                <th>Saldo</th>
                                <th>Origem da venda</th>
                                <th>Linha</th>
                                <th>Aplicação</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(row => {
                                const value = Number(row.value || 0);
                                const tranType = (row.tranType || '').toUpperCase();
                                // isTransfer: only API entries with type TRANSFERÊNCIA DE CRÉDITO (unvalidated admin transfers).
                                // RECARGA entries with saleOrigin 'Transferência de Crédito' are validated transfers — keep RECARGA badge.
                                const isTransfer = tranType === 'TRANSFERÊNCIA DE CRÉDITO';
                                const valueClass = tranType === 'RECARGA PENDENTE' ? 'usage-pending' : value >= 0 ? 'usage-positive' : 'usage-negative';
                                const badgeClass = tranType === 'USO' ? 'cu-badge-uso'
                                    : isTransfer ? 'cu-badge-transferencia'
                                    : tranType === 'RECARGA' ? 'cu-badge-recarga'
                                    : tranType === 'COMPRA' ? 'cu-badge-compra'
                                    : tranType === 'RECARGA PENDENTE' ? 'cu-badge-rec-pendente'
                                    : tranType === 'INTEGRACAO' ? 'cu-badge-integracao'
                                    : 'cu-badge-other';
                                const hasSaleOrigin = tranType === 'RECARGA' || tranType === 'COMPRA' || tranType === 'RECARGA PENDENTE' || isTransfer;
                                // TC entries from the API have no saleOrigin — show label directly without loading spinner.
                                const effectiveOrigin = isTransfer ? (row.saleOrigin || 'Transferência de Crédito') : row.saleOrigin;
                                const saleOrigin = effectiveOrigin || row.saleType || row.saleDatetime
                                    ? `
                                        <span class="cu-sale-origin">${escapeHtml(effectiveOrigin || '-')}</span>
                                        ${row.saleType ? `<span>${escapeHtml(row.saleType)}</span>` : ''}
                                        ${row.saleDatetime ? `<span>${escapeHtml(row.saleDatetime)}</span>` : ''}
                                        ${row.saleReceipt ? `<span>Recibo ${escapeHtml(row.saleReceipt)}</span>` : ''}
                                    `
                                    : '<span class="cu-origin-loading">Consultando...</span>';
                                const originKey = `${row.datetime || ''}|${Number(row.value || 0).toFixed(2)}|${row.tranSequence || ''}`;
                                const dtParts = (row.datetime || '').split(' ');
                                const dtDate = dtParts[0] ? dtParts[0].split('-').reverse().join('/') : '-';
                                const dtTime = dtParts[1] || '';
                                return `
                                    <tr>
                                        <td>
                                            <div class="cu-date">${dtDate}</div>
                                            ${dtTime ? `<div class="cu-time">${dtTime}</div>` : ''}
                                        </td>
                                        <td>
                                            <span class="cu-badge ${badgeClass}">${escapeHtml(tranType || '-')}</span>
                                            <span class="cu-seq">Seq. ${escapeHtml(row.tranSequence || '-')}</span>
                                        </td>
                                        <td><strong class="${valueClass}" style="font-size:0.95rem">${formatMoneyBR(value)}</strong></td>
                                        <td style="color:var(--text-sec);font-size:0.88rem">${formatMoneyBR(row.purse || 0)}</td>
                                        <td class="cu-sale-origin-cell" data-origin-key="${escapeHtml(originKey)}">${hasSaleOrigin ? saleOrigin : '<span style="color:var(--text-muted)">-</span>'}</td>
                                        <td>
                                            ${tranType === 'COMPRA'
                                                ? '<span style="color:var(--text-muted)">-</span>'
                                                : `<span style="font-weight:600;font-size:0.82rem">${escapeHtml(row.lineCode || '-')}</span>
                                                   ${row.lineDesc ? `<span style="display:block;color:var(--text-sec);font-size:0.73rem;margin-top:2px;line-height:1.3">${escapeHtml(row.lineDesc)}</span>` : ''}`}
                                        </td>
                                        <td style="font-size:0.82rem;color:var(--text-sec)">${escapeHtml(row.appDesc || '-')}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
            loadCardUsageSaleOrigins(card, rows);
        } catch (error) {
            content.innerHTML = `
                <div class="card-usage-empty error">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <strong>Erro ao consultar</strong>
                    <span>${escapeHtml(error.message || 'Falha de conexão.')}</span>
                </div>
            `;
        }
    };

    async function loadCardUsageSaleOrigins(card, rows) {
        const recharges = (rows || [])
            .filter(row => ['RECARGA', 'COMPRA', 'RECARGA PENDENTE'].includes(String(row.tranType || '').toUpperCase()))
            .map(row => ({
                datetime: row.datetime,
                value: row.value,
                tranSequence: row.tranSequence,
            }));
        if (!recharges.length) return;

        try {
            const res = await fetch('/api/card_usage_sale_origins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ card, recharges }),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok || !payload.ok) return;

            const origins = payload.origins || {};
            document.querySelectorAll('.cu-sale-origin-cell[data-origin-key]').forEach(cell => {
                const origin = origins[cell.dataset.originKey];
                if (!origin) {
                    // Only overwrite "Consultando..." placeholders, not cells with pre-set content.
                    if (!cell.querySelector('.cu-origin-loading')) return;
                    cell.innerHTML = '<span style="color:var(--text-muted)">Não localizada</span>';
                    return;
                }
                cell.innerHTML = `
                    <span class="cu-sale-origin">${escapeHtml(origin.saleOrigin || '-')}</span>
                    ${origin.saleType ? `<span>${escapeHtml(origin.saleType)}</span>` : ''}
                    ${origin.saleDatetime ? `<span>${escapeHtml(origin.saleDatetime)}</span>` : ''}
                    ${origin.saleReceipt ? `<span>Recibo ${escapeHtml(origin.saleReceipt)}</span>` : ''}
                `;
            });
        } catch (error) {
            document.querySelectorAll('.cu-sale-origin-cell .cu-origin-loading').forEach(el => {
                el.textContent = 'Não localizada';
                el.classList.remove('cu-origin-loading');
            });
        }
    }

    function renderSingleResult(data) {
        // ===== Determine best contact from all sources =====
        const sources = [];
        let bestName = '';
        let bestEmail = '';
        let bestEmailSrc = '';
        let bestPhone = '';
        let bestPhoneSrc = '';
        let bestAddress = '';
        let bestAddressSrc = '';

        // LegacyDB (cad_unico) is primary
        if (data.cad_unico) {
            sources.push({ key: 'legacydb', name: 'LegacyDB', icon: 'fa-credit-card', color: '#EC4899' });
            if (data.cad_unico.nome) bestName = data.cad_unico.nome;
            if (data.cad_unico.email && !bestEmail) { bestEmail = data.cad_unico.email; bestEmailSrc = 'LegacyDB'; }
            if (data.cad_unico.telefone && !bestPhone) { bestPhone = data.cad_unico.telefone; bestPhoneSrc = 'LegacyDB'; }
            if (data.cad_unico.endereco && !bestAddress) { bestAddress = data.cad_unico.endereco; bestAddressSrc = 'LegacyDB'; }
        }
        if (data.sntr_cliente) {
            sources.push({ key: 'cliente', name: 'Portal Cliente', icon: 'fa-users', color: '#3B82F6' });
            if (!bestName && data.sntr_cliente.nome) bestName = data.sntr_cliente.nome;
            if (!bestEmail && data.sntr_cliente.email) { bestEmail = data.sntr_cliente.email; bestEmailSrc = 'Portal Cliente'; }
            if (!bestPhone && data.sntr_cliente.celular) { bestPhone = data.sntr_cliente.celular; bestPhoneSrc = 'Portal Cliente'; }
            if (!bestAddress && data.sntr_cliente.endereco) { bestAddress = data.sntr_cliente.endereco; bestAddressSrc = 'Portal Cliente'; }
        }
        if (data.databridge_db_alunos) {
            sources.push({ key: 'estudante', name: 'Estudante', icon: 'fa-user-graduate', color: '#8B5CF6' });
            if (!bestName && data.databridge_db_alunos.nome) bestName = data.databridge_db_alunos.nome;
            if (!bestEmail && data.databridge_db_alunos.email) { bestEmail = data.databridge_db_alunos.email; bestEmailSrc = 'Estudante'; }
            if (!bestPhone && data.databridge_db_alunos.celular) { bestPhone = data.databridge_db_alunos.celular; bestPhoneSrc = 'Estudante'; }
            if (!bestAddress && data.databridge_db_alunos.endereco) { bestAddress = data.databridge_db_alunos.endereco; bestAddressSrc = 'Estudante'; }
        }
        if (data.abt_data) {
            sources.push({ key: 'abt', name: 'ABT', icon: 'fa-database', color: '#10B981' });
            if (!bestEmail && data.abt_data.email) { bestEmail = data.abt_data.email; bestEmailSrc = 'ABT'; }
            if (!bestPhone && data.abt_data.celular) { bestPhone = data.abt_data.celular; bestPhoneSrc = 'ABT'; }
            if (!bestAddress && data.abt_data.endereco) { bestAddress = data.abt_data.endereco; bestAddressSrc = 'ABT'; }
        }
        if (data.wifi_users) {
            sources.push({ key: 'wifi', name: 'Wifi', icon: 'fa-wifi', color: '#F59E0B' });
            if (!bestEmail && data.wifi_users.email) { bestEmail = data.wifi_users.email; bestEmailSrc = 'Wifi'; }
            if (!bestPhone && data.wifi_users.celular) { bestPhone = data.wifi_users.celular; bestPhoneSrc = 'Wifi'; }
        }
        if (data.whatsapp) {
            sources.push({ key: 'whatsapp', name: 'WhatsApp', icon: 'fa-brands fa-whatsapp', color: '#22C55E' });
            if (!bestPhone && data.whatsapp.telefone) { bestPhone = data.whatsapp.telefone; bestPhoneSrc = 'WhatsApp'; }
        }

        const initials = bestName ? bestName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() : data.cpf.substring(0, 2);

        // ===== PROFILE HEADER =====
        let html = `
        <div class="client-profile">
            <div class="client-profile-top">
                <div class="client-avatar-lg" style="background: var(--accent-gradient);">${initials}</div>
                <div class="client-profile-info">
                    <h2 class="client-name">${bestName || 'Nome não informado'}</h2>
                    <div class="client-cpf"><i class="fa-regular fa-id-card"></i> ${data.cpf}</div>
                    <div class="presence-strip">
                        ${[
                            { name: 'LegacyDB', icon: 'fa-credit-card', color: '#EC4899', found: !!data.cad_unico },
                            { name: 'Portal Cliente', icon: 'fa-users', color: '#3B82F6', found: !!data.sntr_cliente },
                            { name: 'Portal Estudante', icon: 'fa-user-graduate', color: '#8B5CF6', found: !!data.databridge_db_alunos },
                            { name: 'ABT', icon: 'fa-database', color: '#10B981', found: !!data.abt_data },
                            { name: 'Wifi Max', icon: 'fa-wifi', color: '#F59E0B', found: !!data.wifi_users },
                            { name: 'WhatsApp', icon: 'fa-brands fa-whatsapp', color: '#22C55E', found: !!data.whatsapp },
                        ].map(b => {
                            const ic = b.icon.includes(' ') ? b.icon : `fa-solid ${b.icon}`;
                            return b.found
                                ? `<span class="presence-chip found" style="background:${b.color}20;color:${b.color};border-color:${b.color}40"><i class="${ic}"></i> ${b.name}</span>`
                                : `<span class="presence-chip missing" title="Não cadastrado nesta base"><i class="${ic}"></i> ${b.name}</span>`;
                        }).join('')}
                    </div>
                </div>
            </div>
        `;

        // ===== CONSOLIDATED CONTACT =====
        html += `<div class="client-contact-strip">`;

        // Helper to add warning if not from LegacyDB
        const getWarningHtml = (src) => {
            if (src === 'LegacyDB') return '';
            return `<i class="fa-solid fa-triangle-exclamation contact-warning" title="Este dado não está no LegacyDB! Foi preenchido através da base ${src}."></i>`;
        };

        const makeChip = (iconCls, value, src, withCopy) => {
            const isWarn = src !== 'LegacyDB';
            const warnIcon = isWarn
                ? `<i class="fa-solid fa-triangle-exclamation contact-warning" title="Este dado não está no LegacyDB! Fonte: ${src}."></i>`
                : '';
            const copyBtn = withCopy
                ? `<button class="copy-btn" onclick="navigator.clipboard.writeText('${value.replace(/'/g,"\\'")}'); this.querySelector('i').className='fa-solid fa-check'; setTimeout(()=>this.querySelector('i').className='fa-regular fa-copy',1500)" title="Copiar"><i class="fa-regular fa-copy"></i></button>`
                : '';
            return `<div class="contact-chip ${isWarn ? 'has-warning' : ''}">
                <i class="${iconCls}"></i>
                <div class="contact-chip-body">
                    <span class="contact-chip-value">${value}</span>
                    <div class="contact-chip-meta">${warnIcon}<small class="contact-origin">${src}</small></div>
                </div>
                ${copyBtn}
            </div>`;
        };

        if (bestEmail)   html += makeChip('fa-regular fa-envelope',       bestEmail,   bestEmailSrc,   true);
        if (bestPhone)   html += makeChip('fa-solid fa-mobile-screen',     bestPhone,   bestPhoneSrc,   true);
        if (bestAddress) html += makeChip('fa-solid fa-map-location-dot',  bestAddress, bestAddressSrc, false);
        if (!bestEmail && !bestPhone && !bestAddress) {
            html += `<div class="contact-chip" style="color:var(--text-sec)"><i class="fa-solid fa-circle-exclamation"></i> Nenhum contato encontrado em nenhuma base</div>`;
        }
        html += `</div></div>`; // close contact-strip + profile

        // ===== SOURCES DETAIL =====
        html += `<div class="sources-detail-grid">`;

        if (data.sntr_cliente) {
            const c = data.sntr_cliente;
            html += buildSourceCard('Portal Cliente', 'fa-users', '#3B82F6', [
                { icon: 'fa-envelope', label: 'E-mail', value: c.email },
                { icon: 'fa-mobile-screen', label: 'Celular', value: c.celular },
                { icon: 'fa-map-pin', label: 'Endereço', value: c.endereco },
            ]);
        }
        if (data.databridge_db_alunos) {
            const a = data.databridge_db_alunos;
            const reqCount = data.requisicoes_estudante ? data.requisicoes_estudante.length : 0;
            const lastReq = reqCount > 0 ? data.requisicoes_estudante[0] : null;
            const lastStatus = lastReq ? lastReq.status : null;
            const sColor = lastStatus === 'Aprovado' ? 'var(--success)' : (lastStatus === 'Expirado' ? 'var(--danger)' : 'var(--warning)');
            const estudanteFooter = `
                <button class="source-card-action-btn" onclick="document.getElementById('modal-estudante').style.display='flex'" type="button">
                    ${reqCount > 0
                        ? `<span class="req-count-chip" style="background:${sColor}15;color:${sColor};border-color:${sColor}40">${reqCount} requisição${reqCount !== 1 ? 'ões' : ''} · ${lastStatus}</span>`
                        : '<span class="req-count-chip req-count-empty">Nenhuma requisição</span>'
                    }
                    <span>Ver histórico <i class="fa-solid fa-arrow-right" style="font-size:0.65rem"></i></span>
                </button>`;
            html += buildSourceCard('Portal Estudante', 'fa-user-graduate', '#8B5CF6', [
                { icon: 'fa-envelope', label: 'E-mail', value: a.email },
                { icon: 'fa-mobile-screen', label: 'Celular', value: a.celular },
                { icon: 'fa-map-pin', label: 'Endereço', value: a.endereco },
            ], estudanteFooter);
        }
        if (data.abt_data) {
            const a = data.abt_data;
            html += buildSourceCard('ABT Data', 'fa-database', '#10B981', [
                { icon: 'fa-envelope', label: 'E-mail', value: a.email },
                { icon: 'fa-mobile-screen', label: 'Celular', value: a.celular },
                { icon: 'fa-map-pin', label: 'Bairro', value: a.endereco },
                { icon: 'fa-calendar', label: 'Cadastro', value: a.data_cadastro ? a.data_cadastro.split(' ')[0] : null },
                { icon: 'fa-tag', label: 'Status', value: a.status },
            ]);
        }
        if (data.wifi_users) {
            const w = data.wifi_users;
            html += buildSourceCard('Wifi Max', 'fa-wifi', '#F59E0B', [
                { icon: 'fa-envelope', label: 'E-mail', value: w.email },
                { icon: 'fa-mobile-screen', label: 'Celular', value: w.celular },
            ]);
        }
        if (data.whatsapp) {
            html += buildSourceCard('WhatsApp', 'fa-brands fa-whatsapp', '#22C55E', [
                { icon: 'fa-phone', label: 'Telefone', value: data.whatsapp.telefone },
            ]);
        }
        html += `</div>`;

        // ===== LEGACYDB CARDS SECTION =====
        if (data.cad_unico) {
            const cad = data.cad_unico;
            html += `<div class="glass-panel" style="margin-top:20px; border-left: 4px solid var(--accent-primary);">
                <div class="section-title-row">
                    <span class="section-title" style="color:var(--accent-primary); font-size:1.1rem;"><i class="fa-solid fa-credit-card"></i> Cartões LegacyDB</span>
                    <span class="text-muted" style="font-size:0.75rem;"><i class="fa-solid fa-rotate" style="margin-right:4px;opacity:0.4;"></i>Atualizado: ${cad.data_atualizacao || '-'}</span>
                </div>
                <div class="card-usage-hint">
                    <i class="fa-regular fa-hand-pointer"></i>
                    Clique no número do cartão para consultar usos e recargas dos últimos 30 dias.
                </div>`;

            if (cad.json_parsed && Object.keys(cad.json_parsed).length > 0) {
                for (const [cardType, cardDetails] of Object.entries(cad.json_parsed)) {
                    const cardSubTypes = Object.keys(cardDetails || {}).filter(Boolean).join(' / ');
                    html += `
                    <div class="card-detail-row" style="padding: 10px 0;">
                        <div class="card-visual" style="flex: 1; min-width: 100%; padding: 0; display: flex; flex-direction: column; overflow: hidden; background: linear-gradient(to right, rgba(248, 115, 21, 0.08), rgba(59, 130, 246, 0.08)); border: 1px solid rgba(255,255,255,0.08);">
                            <div class="card-visual-top" style="padding: 16px 20px; background: rgba(0,0,0,0.15); border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 0; flex-direction: row; justify-content: space-between; align-items: center;">
                                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                                    <button type="button" class="card-number card-usage-link" data-card-number="${escapeHtml(cardType)}" onclick="openCardUsageModal(this.dataset.cardNumber)" title="Ver usos e recargas dos últimos 30 dias"><i class="fa-regular fa-credit-card"></i> ${escapeHtml(cardType)}</button>
                                    ${cardSubTypes ? `<span class="card-subtype" style="background: rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 6px;" title="Tipo do Cartão">${escapeHtml(cardSubTypes)}</span>` : ''}
                                </div>
                            </div>
                            <div class="card-apps-container" style="display: flex; flex-direction: column;">`;

                    for (const [subType, transactions] of Object.entries(cardDetails)) {
                        for (const [transId, tData] of Object.entries(transactions)) {
                            const saldoVal = tData.saldo !== null ? tData.saldo : 0;
                            const saldoColor = saldoVal > 0 ? 'var(--success)' : (saldoVal < 0 ? 'var(--danger)' : 'var(--text-sec)');
                            const ultUso = tData.ultimo_uso || '-';
                            const ultRecarga = tData.ultima_recarga || tData.ultimo_recarga || '-';
                            const valorRecarga = tData.valor_ultima_recarga ? `R$ ${tData.valor_ultima_recarga.toFixed(2).replace('.', ',')}` : '';

                            const dtInicio = tData.data_inicio ? tData.data_inicio.split(' ')[0].split('-').reverse().join('/') : null;
                            const dtFim = tData.data_final ? tData.data_final.split(' ')[0].split('-').reverse().join('/') : null;
                            const validadeText = (dtInicio || dtFim) ? `${dtInicio || '—'} a ${dtFim || '—'}` : null;

                            let avisoUsoAposVencimento = '';
                            if (tData.ultimo_uso && tData.data_final && tData.ultimo_uso !== '-' && tData.data_final !== '-') {
                                const dtUso = new Date(tData.ultimo_uso.replace(' ', 'T'));
                                const dtFimVal = new Date(tData.data_final.replace(' ', 'T'));
                                if (dtUso > dtFimVal) {
                                    avisoUsoAposVencimento = '<span style="background:rgba(239, 68, 68, 0.15);color:#EF4444;padding:2px 6px;border-radius:4px;font-size:0.65rem;margin-left:8px;border:1px solid rgba(239, 68, 68, 0.3);position:relative;top:-1px;" title="O cartão foi utilizado após a data de validade final."><i class="fa-solid fa-triangle-exclamation"></i> Uso após vencimento</span>';
                                }
                            }

                            html += `
                                <div class="app-row" style="display: flex; flex-wrap: wrap; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.03);">
                                    <div class="app-info" style="flex: 1; min-width: 200px; padding-right: 20px; display: flex; flex-direction: column; justify-content: center;">
                                        <span class="card-saldo" style="color:${saldoColor}; font-size: 1.35rem; font-weight: 800; margin-bottom: 8px;">R$ ${saldoVal.toFixed(2).replace('.', ',')}</span>
                                        <div class="card-visual-meta" style="justify-content: flex-start; gap: 12px;">
                                            <span class="card-id" style="align-self: center; opacity: 0.7;" title="Aplicação do Cartão">Aplicação: ${APP_NAMES[transId] || transId}</span>
                                        </div>
                                    </div>
                                    <div class="card-timeline" style="flex: 2; min-width: 250px; padding-left: 20px; border-left: 1px solid rgba(255,255,255,0.05);">
                                        <div class="legacydb-info-grid">
                                            <div class="legacydb-info-item">
                                                <div class="legacydb-info-label"><i class="fa-solid fa-bus" style="color:#60A5FA"></i> ÚLTIMO USO</div>
                                                <div class="legacydb-info-value">${ultUso}${avisoUsoAposVencimento}</div>
                                            </div>
                                            <div class="legacydb-info-item">
                                                <div class="legacydb-info-label"><i class="fa-solid fa-money-bill-transfer" style="color:var(--success)"></i> ÚLTIMA RECARGA</div>
                                                <div class="legacydb-info-value">${ultRecarga}${valorRecarga ? '<br><strong style="color:var(--success)">' + valorRecarga + '</strong>' : ''}</div>
                                            </div>
                                        </div>`;

                            if (validadeText) {
                                html += `
                                        <div class="timeline-item" style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1);">
                                            <i class="fa-solid fa-calendar-check" style="color:#A855F7"></i>
                                            <div><strong>Validade Aplicação</strong><br><span>${validadeText}</span></div>
                                        </div>`;
                            }

                            if (tData.recarga_pendente) {
                                const valPend = tData.valor_recarga_pendente ? `R$ ${tData.valor_recarga_pendente.toFixed(2).replace('.', ',')}` : '';
                                html += `
                                        <div class="timeline-item timeline-pending" style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1);">
                                            <i class="fa-solid fa-clock" style="color:var(--warning)"></i>
                                            <div><strong>Recarga Pendente</strong><br><span>${tData.recarga_pendente} ${valPend}</span></div>
                                        </div>`;
                            }

                            html += `</div></div>`; // close card-timeline and app-row
                        }
                    }
                    html += `</div></div></div>`; // close card-apps-container, card-visual, and card-detail-row
                }
            } else {
                html += `<div class="text-muted" style="padding:20px 0;text-align:center;"><i class="fa-solid fa-folder-open" style="font-size:1.5rem;opacity:0.4;display:block;margin-bottom:8px;"></i>Nenhum cartão registrado</div>`;
            }
            html += `</div>`;
        } else {
            html += `<div class="glass-panel" style="margin-top:20px;text-align:center;padding:30px;">
                <i class="fa-solid fa-folder-open" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:10px;"></i>
                <span class="text-muted">Nenhum registro encontrado no LegacyDB (CAD ÚNICO)</span>
            </div>`;
        }

        // ===== ESTUDANTE REQUIRES (MODAL) =====
        if (data.databridge_db_alunos || (data.requisicoes_estudante && data.requisicoes_estudante.length > 0)) {
            html += `
            <div id="modal-estudante" class="student-history-modal" onclick="if(event.target === this) this.style.display='none'">
                <div class="glass-panel student-history-dialog">
                    <button class="student-history-close" onclick="document.getElementById('modal-estudante').style.display='none'" title="Fechar">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                    
                    <div class="student-history-header">
                        <div class="student-history-title">
                            <div class="student-history-title-icon">
                                <i class="fa-solid fa-graduation-cap"></i>
                            </div>
                            Histórico Portal Estudante
                        </div>
                        <a href="#" class="student-history-link" onclick="const cpf = document.getElementById('cpf-input').value.replace(/\\D/g, ''); if(navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(cpf).then(() => window.open('https://estudante.example.com/alunos', '_blank')); } else { const ta = document.createElement('textarea'); ta.value = cpf; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); window.open('https://estudante.example.com/alunos', '_blank'); }">
                            Ir para Portal Estudante <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.75rem;"></i>
                        </a>
                    </div>`;

            if (data.requisicoes_estudante && data.requisicoes_estudante.length > 0) {
                html += `<div class="student-history-list">`;
                data.requisicoes_estudante.forEach(req => {
                    const isAprovado = req.status === 'Aprovado';
                    const statusColor = isAprovado ? 'var(--success)' : (req.status === 'Expirado' ? 'var(--danger)' : 'var(--warning)');
                    const statusBg = isAprovado ? 'rgba(16,185,129,0.1)' : (req.status === 'Expirado' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)');
                    const statusIcon = isAprovado ? 'fa-circle-check' : 'fa-circle-exclamation';

                    const inicio = req.data_inicio ? req.data_inicio.substring(0, 10).split('-').reverse().join('/') : '-';
                    const termino = req.data_termino ? req.data_termino.substring(0, 10).split('-').reverse().join('/') : '-';
                    const dtReq = req.data_requisicao ? req.data_requisicao.substring(0, 10).split('-').reverse().join('/') : '-';

                    html += `
                    <div class="student-history-card" style="border-left-color:${statusColor};">
                        <div class="student-history-card-header">
                            <h4 class="student-history-course">
                                <i class="fa-solid fa-book-open" style="color:rgba(255,255,255,0.4)"></i> 
                                ${req.nome_curso || '-'}
                            </h4>
                            <span class="student-history-status" style="background:${statusBg};color:${statusColor};border-color:${statusColor}40">
                                <i class="fa-solid ${statusIcon}"></i> ${req.status || '-'}
                            </span>
                        </div>
                        <div class="student-history-grid">
                            <div class="data-item student-history-school">
                                <span class="data-label" style="color:#8B5CF6; opacity:0.8"><i class="fa-solid fa-school"></i> ESCOLA / INSTITUIÇÃO</span>
                                <span class="data-value student-history-school-name">${req.nome_escola || '-'} <small>(${req.tipo_instituicao || '-'})</small></span>
                            </div>
                            <div class="data-item">
                                <span class="data-label" style="color:#8B5CF6; opacity:0.8"><i class="fa-solid fa-tag"></i> MODALIDADE</span>
                                <span class="data-value">${req.modalidade || '-'}</span>
                            </div>
                            <div class="data-item">
                                <span class="data-label" style="color:#8B5CF6; opacity:0.8"><i class="fa-solid fa-calendar-days"></i> PERÍODO DO CURSO</span>
                                <span class="data-value">${inicio} a ${termino}</span>
                            </div>
                            <div class="data-item">
                                <span class="data-label" style="color:#8B5CF6; opacity:0.8"><i class="fa-solid fa-clock-rotate-left"></i> DATA DA REQUISIÇÃO</span>
                                <span class="data-value">${dtReq}</span>
                            </div>
                        </div>
                    </div>`;
                });
                html += `</div>`;
            } else {
                html += `<div style="text-align:center;padding:30px 0;background:rgba(139,92,246,0.02);border-radius:12px;border:1px dashed rgba(139,92,246,0.2);">
                    <div style="width:48px;height:48px;border-radius:50%;background:rgba(139,92,246,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 10px auto;">
                        <i class="fa-solid fa-user-graduate" style="font-size:1.5rem;color:#8B5CF6;opacity:0.7;"></i>
                    </div>
                    <div style="color:var(--text);font-weight:500;">Nenhuma requisição</div>
                    <div class="text-muted" style="font-size:0.9rem;margin-top:4px;">Este aluno não possui histórico de requisições no Portal Estudante.</div>
                </div>`;
            }
            html += `</div></div></div>`;

            // Only add global esc listener once
            if (!window.hasEscListener) {
                window.hasEscListener = true;
                document.addEventListener('keydown', function (e) {
                    if (e.key === 'Escape') {
                        const modal = document.getElementById('modal-estudante');
                        if (modal && modal.style.display !== 'none') {
                            modal.style.display = 'none';
                        }
                    }
                });
            }
        }

        resultsSingle.innerHTML = html;
        resultsSingle.classList.remove('hidden');
    }

    function buildSourceCard(title, icon, color, fields, footer = '') {
        const rows = fields.filter(f => f.value).map(f =>
            `<div class="src-field"><i class="fa-solid ${f.icon}" style="color:${color};opacity:0.7;width:16px;"></i><span class="src-label">${f.label}</span><span class="src-value">${f.value}</span></div>`
        ).join('');
        if (!rows && !footer) return '';
        const iconClass = icon.includes(' ') ? icon : `fa-solid ${icon}`;
        return `
        <div class="source-card" style="border-top:3px solid ${color}">
            <div class="source-card-title" style="background:${color}12;margin:-18px -18px 14px -18px;padding:14px 18px;border-radius:calc(var(--radius-lg) - 3px) calc(var(--radius-lg) - 3px) 0 0;">
                <i class="${iconClass}" style="color:${color}"></i> ${title}
            </div>
            ${rows}
            ${footer ? `<div class="source-card-footer">${footer}</div>` : ''}
        </div>`;
    }

    function createDataItem(label, value) {
        return `<div class="data-item">
            <span class="data-label">${label}</span>
            <span class="data-value">${value}</span>
        </div>`;
    }

    // --- BULK SEARCH LOGIC ---
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const procDashboard = document.getElementById('processing-dashboard');
    const progressBar = document.getElementById('progress-bar');
    const progressPerc = document.getElementById('progress-percentage');
    const statusMsg = document.getElementById('status-msg');

    // Socket IO Connection (lazy: only for bulk processing)
    let bulkSocket = null;
    let bulkSocketHandlersBound = false;
    let _bulkJobId = null;
    let _bulkPollInterval = null;
    let _lastSocketEventAt = 0;
    const BULK_POLL_MS = 5000;
    const BULK_SOCKET_SILENCE_MS = 15000;

    function startBulkPolling() {
        stopBulkPolling();
        _bulkPollInterval = setInterval(async () => {
            if (!_bulkJobId) return;
            const silentFor = Date.now() - _lastSocketEventAt;
            if (silentFor > BULK_SOCKET_SILENCE_MS) {
                try {
                    const res = await fetch(`/api/bulk/status/${_bulkJobId}`);
                    const job = await res.json();
                    if (!job.found) return;
                    if (job.status === 'done' && job.download_url) {
                        stopBulkPolling();
                        handleBulkProcessingFinished({ download_url: job.download_url, stats: {}, preview: [] });
                    } else if (job.status === 'error') {
                        stopBulkPolling();
                        updateProgress(0, `Erro: ${job.error_msg || 'falha no processamento'}`);
                        document.getElementById('bulk-processing-warning').style.display = 'none';
                    } else {
                        updateProgress(job.progress || 0, `(reconectando) ${job.msg || 'Processando...'}`);
                    }
                } catch (_) {}
            }
        }, BULK_POLL_MS);
    }

    function stopBulkPolling() {
        if (_bulkPollInterval) { clearInterval(_bulkPollInterval); _bulkPollInterval = null; }
    }

    function ensureBulkSocket() {
        if (!bulkSocket) {
            bulkSocket = io({
                autoConnect: false,
                reconnection: true,
                reconnectionAttempts: 5,
                timeout: 20000
            });
        }

        if (!bulkSocketHandlersBound) {
            bulkSocket.on('job_started', function (data) {
                _bulkJobId = data.job_id;
                _lastSocketEventAt = Date.now();
                startBulkPolling();
            });

            bulkSocket.on('status', function (data) {
                _lastSocketEventAt = Date.now();
                updateProcessingStatus(data);
            });

            bulkSocket.on('finalizado', function (data) {
                _lastSocketEventAt = Date.now();
                stopBulkPolling();
                handleBulkProcessingFinished(data);
            });

            bulkSocket.on('parcial_resultado', function (data) {
                _lastSocketEventAt = Date.now();
                const feed = document.getElementById('live-feed');
                const feedRows = document.getElementById('live-feed-rows');
                if (!feed || !feedRows) return;
                feed.classList.remove('hidden');

                const liveCount = document.getElementById('live-count');
                const liveTotal = document.getElementById('live-total');
                if (liveCount) liveCount.textContent = data.processed.toLocaleString('pt-BR');
                if (liveTotal) liveTotal.textContent = data.total.toLocaleString('pt-BR');
                updateProgress(data.progress, `Cruzando registros... ${data.processed}/${data.total}`);

                const BASE_META = {
                    legacydb:   { label: 'M', color: '#EC4899' },
                    cliente:   { label: 'C', color: '#3B82F6' },
                    estudante: { label: 'E', color: '#06B6D4' },
                    abt:       { label: 'A', color: '#6366F1' },
                    wifi:      { label: 'W', color: '#A855F7' },
                    whatsapp:  { label: 'Z', color: '#22C55E' },
                };

                data.records.forEach(r => {
                    const pills = Object.entries(r.bases)
                        .filter(([, v]) => v)
                        .map(([k]) => {
                            const m = BASE_META[k];
                            return `<span class="bpill" style="background:${m.color}20;color:${m.color};border-color:${m.color}40">${m.label}</span>`;
                        }).join('');
                    const row = document.createElement('div');
                    row.className = 'live-row' + (r.found ? '' : ' live-row-miss');
                    row.innerHTML = `
                        <span class="live-status">${r.found ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>'}</span>
                        <span class="live-nome">${r.nome}</span>
                        <span class="live-tel">${r.telefone !== '—' ? r.telefone : ''}</span>
                        <span class="bpill-group">${pills}</span>`;
                    feedRows.prepend(row);
                    while (feedRows.children.length > 12) feedRows.removeChild(feedRows.lastChild);
                });
            });

            bulkSocketHandlersBound = true;
        }

        if (!bulkSocket.connected) {
            bulkSocket.connect();
        }

        return bulkSocket;
    }

    function disconnectBulkSocket() {
        stopBulkPolling();
        _bulkJobId = null;
        if (bulkSocket && bulkSocket.connected) {
            bulkSocket.disconnect();
        }
    }

    window.addEventListener('beforeunload', () => {
        disconnectBulkSocket();
    });

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', e => { e.preventDefault(); dropZone.classList.remove('dragover'); });
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            showBulkPreview(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', e => {
        if (e.target.files.length) {
            showBulkPreview(e.target.files[0]);
        }
    });

    // ── Preview da planilha antes de processar ──────────────────────────────
    let _pendingBulkFile = null;

    async function showBulkPreview(file) {
        if (!file.name.endsWith('.csv') && !file.name.endsWith('.xlsx')) {
            alert('Apenas arquivos .csv ou .xlsx são permitidos.');
            return;
        }
        _pendingBulkFile = file;

        const panel = document.getElementById('bulk-preview-panel');
        if (!panel) { handleFileUpload(file); return; }

        dropZone.classList.add('hidden');
        panel.classList.remove('hidden');
        panel.innerHTML = `<div class="bpp-loading"><div class="modern-spinner" style="width:22px;height:22px;border-width:2px;"></div> Analisando planilha...</div>`;

        try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch('/api/preview_planilha', { method: 'POST', body: fd });
            const d = await res.json();
            if (d.error) throw new Error(d.error);
            renderBulkPreviewPanel(panel, file.name, d);
        } catch (err) {
            panel.innerHTML = `<div style="padding:20px;color:var(--danger);"><i class="fa-solid fa-triangle-exclamation"></i> Erro ao analisar: ${err.message}</div>
                <div style="padding:0 20px 16px;"><button class="bpp-cancel-btn" onclick="resetBulkToUpload()">Voltar</button></div>`;
        }
    }

    function renderBulkPreviewPanel(panel, fileName, d) {
        const BASE_DEFS = [
            { key: 'legacydb',   label: 'LegacyDB',       icon: 'fa-credit-card',     color: '#EC4899' },
            { key: 'cliente',   label: 'Portal Cliente', icon: 'fa-user',           color: '#3B82F6' },
            { key: 'estudante', label: 'Portal Estudante',  icon: 'fa-book-open',       color: '#06B6D4' },
            { key: 'abt',       label: 'ABT',            icon: 'fa-building',        color: '#6366F1' },
            { key: 'wifi',      label: 'Wifi Max',       icon: 'fa-wifi',            color: '#A855F7' },
            { key: 'whatsapp',  label: 'WhatsApp',       icon: 'fa-brands fa-whatsapp', color: '#22C55E' },
        ];

        const colTags = d.colunas.map(c => {
            const isCpf = c === d.cpf_coluna;
            return `<span class="bpp-col-tag${isCpf ? ' is-cpf' : ''}">${isCpf ? '<i class="fa-solid fa-key" style="font-size:0.65rem;margin-right:3px;"></i>' : ''}${c}</span>`;
        }).join('');

        const baseChips = BASE_DEFS.map(b =>
            `<span class="bpp-base-chip" style="background:${b.color}12;color:${b.color};border-color:${b.color}30">
                <i class="${b.icon.includes(' ') ? b.icon : 'fa-solid ' + b.icon}" style="font-size:0.8rem;"></i>${b.label}
            </span>`
        ).join('');

        const LIMIT = 300000;
        const totalRows = d.total_rows || d.amostra_lida;
        const overLimit = totalRows > LIMIT;
        const cpfsText = d.cpfs_validos > 0 ? `${d.cpfs_validos.toLocaleString('pt-BR')} CPFs válidos detectados` : 'Verifique se a coluna correta foi selecionada';
        const cpfBadge = d.cpfs_validos > 0 ? 'Detectado automaticamente' : 'Verificar';
        const shortName = fileName.length > 40 ? fileName.slice(0, 37) + '…' : fileName;
        const rowsLabel = totalRows.toLocaleString('pt-BR') + ' linha(s) · ' + d.colunas.length + ' coluna(s)';

        const limitBanner = overLimit ? `
        <div class="bpp-limit-banner">
            <i class="fa-solid fa-triangle-exclamation"></i>
            Planilha com <strong>${totalRows.toLocaleString('pt-BR')}</strong> linhas excede o limite de
            <strong>${LIMIT.toLocaleString('pt-BR')}</strong> por cruzamento.
            Divida o arquivo em lotes menores.
        </div>` : '';

        panel.innerHTML = `
        <div class="bpp-file-bar">
            <div class="bpp-file-icon"><i class="fa-regular fa-file-excel"></i></div>
            <div>
                <div class="bpp-file-name">${shortName}</div>
                <div class="bpp-file-sub">${rowsLabel}</div>
            </div>
        </div>

        ${limitBanner}

        <div class="bpp-section-label">Coluna de CPF detectada</div>
        <div class="bpp-cpf-box">
            <div class="bpp-cpf-icon"><i class="fa-solid fa-key"></i></div>
            <div>
                <div class="bpp-cpf-col-name">${d.cpf_coluna}</div>
                <div class="bpp-cpf-count">${cpfsText}</div>
            </div>
            <span class="bpp-cpf-badge">${cpfBadge}</span>
        </div>

        <div class="bpp-section-label">Colunas da sua planilha</div>
        <div class="bpp-cols-wrap">${colTags}</div>

        <div class="bpp-section-label">Será cruzado com as 6 bases</div>
        <div class="bpp-bases-grid">${baseChips}</div>

        <div class="bpp-actions">
            <button class="bpp-cancel-btn" onclick="resetBulkToUpload()">
                <i class="fa-solid fa-xmark" style="margin-right:4px;"></i> Cancelar
            </button>
            <button class="bpp-process-btn" onclick="startBulkProcessing()" ${overLimit ? 'disabled title="Reduza o arquivo para no máximo 300.000 linhas"' : ''}>
                Iniciar Cruzamento <i class="fa-solid fa-arrow-right"></i>
            </button>
        </div>`;
    }

    window.resetBulkToUpload = function() {
        _pendingBulkFile = null;
        fileInput.value = '';
        const panel = document.getElementById('bulk-preview-panel');
        if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; }
        dropZone.classList.remove('hidden');
    };

    window.startBulkProcessing = function() {
        if (!_pendingBulkFile) return;
        const panel = document.getElementById('bulk-preview-panel');
        if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; }
        handleFileUpload(_pendingBulkFile);
        _pendingBulkFile = null;
    };
    // ────────────────────────────────────────────────────────────────────────

    // Reset Bulk Search UI
    document.getElementById('btn-new-bulk-search')?.addEventListener('click', (e) => {
        e.preventDefault();

        // Limpar preview panel
        _pendingBulkFile = null;
        const previewPanel = document.getElementById('bulk-preview-panel');
        if (previewPanel) { previewPanel.classList.add('hidden'); previewPanel.innerHTML = ''; }

        // Hide processing dashboard and show drop zone
        procDashboard.classList.add('hidden');
        dropZone.classList.remove('hidden');

        // Reset properties
        progressBar.style.width = '0%';
        progressPerc.textContent = '0%';
        progressPerc.style = ''; // Remove massive font styling applied at end
        statusMsg.style.display = '';
        statusMsg.textContent = 'Iniciando...';

        document.getElementById('status-title').innerHTML = 'Processando Planilha...';
        document.querySelector('.pulse-indicator').style.display = '';

        document.getElementById('results-summary').classList.add('hidden');
        document.getElementById('download-section').classList.add('hidden');

        // Hide the reset button itself
        const btnReset = document.getElementById('btn-new-bulk-search');
        if (btnReset) btnReset.style.display = 'none';

        // Limpar ticker ao vivo
        const liveFeed = document.getElementById('live-feed');
        if (liveFeed) {
            liveFeed.classList.add('hidden');
            const feedRows = document.getElementById('live-feed-rows');
            if (feedRows) feedRows.innerHTML = '';
            const liveCount = document.getElementById('live-count');
            if (liveCount) liveCount.textContent = '0';
            const liveTotal = document.getElementById('live-total');
            if (liveTotal) liveTotal.textContent = '?';
        }

        fileInput.value = '';
    });

    async function handleFileUpload(file) {
        if (!file.name.endsWith('.csv') && !file.name.endsWith('.xlsx')) {
            alert('Apenas arquivos .csv ou .xlsx são permitidos.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        procDashboard.classList.remove('hidden');
        dropZone.classList.add('hidden');
        document.getElementById('bulk-processing-warning').style.display = 'flex';
        updateProgress(5, "Fazendo upload do arquivo...");

        try {
            const res = await fetch('/upload_file', { method: 'POST', body: formData });
            const data = await res.json();

            if (data.filename) {
                updateProgress(10, "Arquivo recebido. Iniciando processamento server-side...");
                const username = currentUser ? currentUser.username : 'Desconhecido';
                const userId = currentUser ? currentUser.id : 0;
                ensureBulkSocket().emit('iniciar_processamento', { filename: data.filename, username: username, user_id: userId });
            } else {
                throw new Error(data.error || "Erro no upload");
            }
        } catch (e) {
            updateProgress(0, `Erro: ${e.message}`);
            document.getElementById('bulk-processing-warning').style.display = 'none';
        }
    }

    function updateProgress(percent, msg) {
        progressBar.style.width = `${percent}%`;
        progressPerc.textContent = `${percent}%`;
        statusMsg.textContent = msg;
    }

    function updateProcessingStatus(data) {
        updateProgress(data.progress, data.msg);
    }

    function buildPreviewTable(rows) {
        const BASE_META = {
            legacydb:   { label: 'M', color: '#EC4899' },
            cliente:   { label: 'C', color: '#3B82F6' },
            estudante: { label: 'E', color: '#06B6D4' },
            abt:       { label: 'A', color: '#6366F1' },
            wifi:      { label: 'W', color: '#A855F7' },
            whatsapp:  { label: 'Z', color: '#22C55E' },
        };
        const rowsHtml = rows.map(r => {
            const pills = Object.entries(r.bases)
                .filter(([, v]) => v)
                .map(([k]) => {
                    const m = BASE_META[k];
                    return `<span class="bpill" style="background:${m.color}20;color:${m.color};border-color:${m.color}40">${m.label}</span>`;
                }).join('');
            const emailCell = (r.email === '—' && r.email_fake)
                ? `<span class="fake-email-warn"><i class="fa-solid fa-triangle-exclamation"></i> @cadunico</span>`
                : (r.email !== '—' ? r.email : '<span class="no-data">—</span>');
            const phoneCell = r.telefone !== '—'
                ? `<span class="phone-pill">${r.telefone}</span>`
                : '<span class="no-data">—</span>';
            return `<tr>
                <td class="cpf-cell">${r.cpf}</td>
                <td class="nome-cell">${r.nome}</td>
                <td>${phoneCell}</td>
                <td class="email-cell">${emailCell}</td>
                <td><div class="bpill-group">${pills || '<span class="no-data">Nenhuma</span>'}</div></td>
            </tr>`;
        }).join('');
        return `
        <div class="bulk-preview-section">
            <div class="bulk-preview-header">
                <i class="fa-solid fa-table-list"></i> Prévia dos dados
                <span class="preview-count">${rows.length} primeiros registros</span>
            </div>
            <div class="bulk-preview-scroll">
                <table class="bulk-preview-table">
                    <thead><tr>
                        <th>CPF</th><th>Nome</th><th>Melhor Telefone</th>
                        <th>Melhor E-mail</th><th>Bases</th>
                    </tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        </div>`;
    }

    function handleBulkProcessingFinished(data) {
        updateProgress(100, "Concluído com Sucesso!");
        document.querySelector('.pulse-indicator').style.display = 'none';

        // Esconder o ticker ao vivo
        const liveFeed = document.getElementById('live-feed');
        if (liveFeed) liveFeed.classList.add('hidden');

        document.getElementById('status-title').innerHTML = "<span style='display:inline-flex; align-items:center; gap:8px; background: rgba(16,185,129,0.1); color: var(--success); padding: 8px 16px; border-radius: 6px; border: 1px solid rgba(16,185,129,0.3); font-size: 0.9rem; font-weight: bold; text-transform: uppercase;'><i class='fa-solid fa-check'></i> CONCLUÍDO COM SUCESSO!</span>";
        document.getElementById('status-msg').style.display = 'none';

        const perc = document.getElementById('progress-percentage');
        perc.style.fontSize = '2.2rem';
        perc.style.color = '#3B82F6';
        perc.style.fontWeight = 'bold';
        perc.style.position = 'absolute';
        perc.style.top = '22px';
        perc.style.right = '24px';

        document.getElementById('processing-dashboard').style.position = 'relative';

        const formatNum = (num) => (num !== undefined && num !== null) ? num.toLocaleString('pt-BR') : '0';

        const sumGrid = document.getElementById('results-summary');
        sumGrid.className = 'mt-4';
        sumGrid.innerHTML = `
            <div class="bulk-results-wrapper">
                <div class="quality-insights">
                    <div class="quality-card qi-phones">
                        <i class="fa-solid fa-phone-flip"></i>
                        <div class="qi-value">${formatNum(data.stats.phones_normalized || 0)}</div>
                        <div class="qi-label">Telefones normalizados</div>
                    </div>
                    <div class="quality-card qi-emails${(data.stats.emails_falsos || 0) > 0 ? ' has-issues' : ''}">
                        <i class="fa-solid fa-envelope-circle-check"></i>
                        <div class="qi-value">${formatNum(data.stats.emails_falsos || 0)}</div>
                        <div class="qi-label">E-mails @cadunico (Área Cliente)</div>
                    </div>
                    <div class="quality-card qi-multi">
                        <i class="fa-solid fa-layer-group"></i>
                        <div class="qi-value">${formatNum(data.stats.multi_base || 0)}</div>
                        <div class="qi-label">CPFs em múltiplas bases</div>
                    </div>
                </div>

                <div class="results-top-cards" style="margin-bottom:16px;">
                    <div class="result-card-main">
                        <div class="result-card-title">TOTAL PLANILHA <i class="fa-regular fa-file"></i></div>
                        <div class="result-card-value">${formatNum(data.stats.total_planilha)}</div>
                    </div>
                    <div class="result-card-main border-success">
                        <div class="result-card-title text-success">ENCONTRADOS (GERAL) <i class="fa-regular fa-circle-check"></i></div>
                        <div class="result-card-value text-success">${formatNum(data.stats.total_geral)}</div>
                    </div>
                </div>

                <div class="detalhamento-panel">
                    <div class="detalhamento-title">COBERTURA POR BASE</div>
                    <div class="detalhamento-grid">
                        <div class="det-card">
                            <i class="fa-solid fa-credit-card icon" style="color: #EC4899"></i>
                            <div class="det-label">LEGACYDB</div>
                            <div class="det-val" style="color: #EC4899">${formatNum(data.stats.cad_unico)}</div>
                        </div>
                        <div class="det-card">
                            <i class="fa-regular fa-user icon" style="color: #3B82F6"></i>
                            <div class="det-label">ÁREA CLIENTE</div>
                            <div class="det-val" style="color: #3B82F6">${formatNum(data.stats.cliente)}</div>
                        </div>
                        <div class="det-card">
                            <i class="fa-solid fa-book-open icon" style="color: #06B6D4"></i>
                            <div class="det-label">ESTUDANTES</div>
                            <div class="det-val" style="color: #06B6D4">${formatNum(data.stats.estudante)}</div>
                        </div>
                        <div class="det-card">
                            <i class="fa-regular fa-building icon" style="color: #6366F1"></i>
                            <div class="det-label">ABT</div>
                            <div class="det-val" style="color: #6366F1">${formatNum(data.stats.abt)}</div>
                        </div>
                        <div class="det-card">
                            <i class="fa-solid fa-wifi icon" style="color: #A855F7"></i>
                            <div class="det-label">WIFI MAX</div>
                            <div class="det-val" style="color: #A855F7">${formatNum(data.stats.wifi)}</div>
                        </div>
                        <div class="det-card">
                            <i class="fa-brands fa-whatsapp icon" style="color: #22C55E"></i>
                            <div class="det-label">WHATSAPP</div>
                            <div class="det-val" style="color: #22C55E">${formatNum(data.stats.whatsapp)}</div>
                        </div>
                    </div>
                </div>

                ${data.preview && data.preview.length ? buildPreviewTable(data.preview) : ''}
            </div>
        `;
        sumGrid.classList.remove('hidden');

        const dlBtn = document.getElementById('download-btn');
        dlBtn.href = `/download/${data.download_url}`;
        dlBtn.innerHTML = '<i class="fa-solid fa-download" style="margin-right:8px;"></i> BAIXAR PLANILHA PROCESSADA';
        dlBtn.style.padding = '20px';
        dlBtn.style.fontSize = '1.15rem';
        dlBtn.style.textTransform = 'uppercase';
        dlBtn.style.fontWeight = 'bold';
        dlBtn.style.letterSpacing = '1px';
        dlBtn.style.display = 'flex';
        dlBtn.style.alignItems = 'center';
        dlBtn.style.justifyContent = 'center';

        document.getElementById('download-section').classList.remove('hidden');

        // Show the reset button top right
        const btnReset = document.getElementById('btn-new-bulk-search');
        if (btnReset) btnReset.style.display = 'flex';

        // Reload history so the new file appears
        loadBulkHistory();
    }

    async function loadBulkHistory() {
        const section = document.getElementById('bulk-history-section');
        const tbody = document.getElementById('bulk-history-tbody');
        if (!section || !tbody) return;

        section.classList.remove('hidden');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-sec); padding: 20px;"><div class="modern-spinner" style="width:24px;height:24px;border-width:2px;margin:auto;"></div></td></tr>';

        try {
            const res = await fetch('/api/historico_massa');
            if (!res.ok) throw new Error('Erro ao carregar histórico');
            const records = await res.json();

            if (!records || records.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-sec); padding: 20px;">Nenhum cruzamento encontrado no histórico recente.</td></tr>';
                return;
            }

            let html = '';
            records.forEach(r => {
                html += `
                    <tr>
                        <td style="font-weight: 500; color: var(--text-primary);">
                            <i class="fa-regular fa-file-excel" style="color: #10B981; margin-right: 6px;"></i> ${r.nome_arquivo.replace('RES_ANALISE_', '')}
                        </td>
                        <td>${r.data_geracao}</td>
                        <td><span class="user-pill"><i class="fa-regular fa-circle-user"></i> ${r.usuario_gerou}</span></td>
                        <td>${(r.total_cpfs || 0).toLocaleString('pt-BR')} registros</td>
                        <td>
                            <a href="/download/${r.nome_arquivo}" class="btn-download-sm">
                                <i class="fa-solid fa-download"></i> Baixar
                            </a>
                        </td>
                    </tr>
                `;
            });
            tbody.innerHTML = html;
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 20px;">Falha ao carregar o histórico.</td></tr>';
        }
    }

    // --- BI REPORT LOGIC ---
    const reportForm = document.getElementById('report-filters-form');
    let reportCurrentPage = 1;
    let reportSortBy = 'cpf';
    let reportSortDir = 'asc';
    const reportFilterBuilderEl = document.getElementById('report-filter-builder');
    const reportFilterBuilderLoadingEl = document.getElementById('report-filter-builder-loading');
    const reportClearFiltersBtn = document.getElementById('btn-report-clear-filters');
    const reportFilterHelpModal = document.getElementById('report-filter-help-modal');
    const reportFilterHelpBtn = document.getElementById('btn-report-filter-help');
    const reportFilterHelpCloseBtn = document.getElementById('report-filter-help-close');
    let reportFilterIdCounter = 0;
    let reportFilterFields = [];
    let reportFilterState = createReportFilterGroup(true);
    let reportFilterSaveTimeout = null;
    let reportFilterBuilderReady = false;
    let reportFiltersLoaded = false;
    let reportFiltersLoadingPromise = null;

    function openReportFilterHelp() {
        if (!reportFilterHelpModal) return;
        reportFilterHelpModal.classList.remove('hidden');
        requestAnimationFrame(() => reportFilterHelpModal.classList.add('show'));
    }

    function closeReportFilterHelp() {
        if (!reportFilterHelpModal) return;
        reportFilterHelpModal.classList.remove('show');
        setTimeout(() => reportFilterHelpModal.classList.add('hidden'), 180);
    }

    const REPORT_OPERATORS = {
        string: [
            { value: 'contains', label: 'Contém', inputs: 1 },
            { value: 'equals', label: 'Igual a', inputs: 1 },
            { value: 'starts_with', label: 'Começa com', inputs: 1 },
            { value: 'ends_with', label: 'Termina com', inputs: 1 },
            { value: 'is_empty', label: 'Está vazio', inputs: 0 },
            { value: 'is_not_empty', label: 'Não está vazio', inputs: 0 }
        ],
        number: [
            { value: 'equals', label: 'Igual a', inputs: 1 },
            { value: 'gt', label: 'Maior que', inputs: 1 },
            { value: 'gte', label: 'Maior ou igual', inputs: 1 },
            { value: 'lt', label: 'Menor que', inputs: 1 },
            { value: 'lte', label: 'Menor ou igual', inputs: 1 },
            { value: 'between', label: 'Entre', inputs: 2 },
            { value: 'is_empty', label: 'Está vazio', inputs: 0 },
            { value: 'is_not_empty', label: 'Não está vazio', inputs: 0 }
        ],
        date: [
            { value: 'on', label: 'Na data', inputs: 1 },
            { value: 'after', label: 'A partir de', inputs: 1 },
            { value: 'before', label: 'Até', inputs: 1 },
            { value: 'between', label: 'Entre', inputs: 2 },
            { value: 'is_empty', label: 'Está vazio', inputs: 0 },
            { value: 'is_not_empty', label: 'Não está vazio', inputs: 0 }
        ],
        select: [
            { value: 'equals', label: 'Igual a', inputs: 1 },
            { value: 'not_equals', label: 'Diferente de', inputs: 1 },
            { value: 'is_empty', label: 'Está vazio', inputs: 0 },
            { value: 'is_not_empty', label: 'Não está vazio', inputs: 0 }
        ],
        flag: [
            { value: 'is_true', label: 'Sim', inputs: 0 }
        ]
    };

    function createReportFilterGroup(isRoot = false) {
        return {
            id: `group_${++reportFilterIdCounter}`,
            type: 'group',
            condition: 'AND',
            isRoot,
            rules: []
        };
    }

    function getDefaultReportFields() {
        return [
            { id: 'cpf', label: 'CPF', type: 'string', placeholder: 'Somente números ou parte do CPF' },
            { id: 'cartao', label: 'Número do Cartão', type: 'string', placeholder: 'Número completo ou parcial' },
            { id: 'tipo_cartao', label: 'Tipo do Cartão', type: 'select', options: [] },
            { id: 'app_id', label: 'Aplicação (ID)', type: 'select', options: [] },
            { id: 'saldo', label: 'Saldo', type: 'number', placeholder: '0.00' },
            { id: 'valor_ultima_recarga', label: 'Valor da Última Recarga', type: 'number', placeholder: '0.00' },
            { id: 'valor_recarga_pendente', label: 'Valor da Recarga Pendente', type: 'number', placeholder: '0.00' },
            { id: 'ultimo_uso', label: 'Último Uso', type: 'date' },
            { id: 'ultima_recarga', label: 'Última Recarga', type: 'date' },
            { id: 'recarga_pendente', label: 'Recarga Pendente', type: 'date' },
            { id: 'ultima_compra_data', label: 'Última Compra', type: 'date' },
            { id: 'aluno_sem_direito', label: 'Alunos sem Direito', type: 'flag' },
            { id: 'aprovado_sem_cartao_estudantil', label: 'Aprovado sem Cartão Estudantil', type: 'flag' }
        ];
    }

    function getReportFieldDefinition(fieldId) {
        return reportFilterFields.find(field => field.id === fieldId) || reportFilterFields[0];
    }

    function getOperatorOptionsForField(fieldId) {
        const field = getReportFieldDefinition(fieldId);
        return REPORT_OPERATORS[field?.type || 'string'] || REPORT_OPERATORS.string;
    }

    function createReportRule(fieldId = null) {
        const fallbackFieldId = fieldId || reportFilterFields[0]?.id || 'cpf';
        const field = getReportFieldDefinition(fallbackFieldId) || { id: fallbackFieldId };
        const operator = getOperatorOptionsForField(field.id)[0];
        return {
            id: `rule_${++reportFilterIdCounter}`,
            type: 'rule',
            field: field.id,
            operator: operator.value,
            value: '',
            valueTo: ''
        };
    }

    function ensureReportBuilderHasRule() {
        if (!reportFilterState.rules.length) {
            reportFilterState.rules.push(createReportRule());
        }
    }

    function updateReportFilterFields(fields) {
        reportFilterFields = fields;
        normalizeReportGroup(reportFilterState);
        ensureReportBuilderHasRule();
        renderReportFilterBuilder();
    }

    function normalizeReportGroup(group) {
        group.rules.forEach(rule => {
            if (rule.type === 'group') {
                normalizeReportGroup(rule);
                return;
            }
            const field = getReportFieldDefinition(rule.field) || reportFilterFields[0];
            rule.field = field.id;
            const operators = getOperatorOptionsForField(rule.field);
            if (!operators.some(operator => operator.value === rule.operator)) {
                rule.operator = operators[0].value;
                rule.value = '';
                rule.valueTo = '';
            }
        });
    }

    function renderReportFilterBuilder() {
        if (!reportFilterBuilderEl) return;
        reportFilterBuilderEl.innerHTML = '';
        reportFilterBuilderEl.appendChild(renderReportGroup(reportFilterState, 0));
    }

    function setReportFilterBuilderLoading(isLoading) {
        reportFilterBuilderReady = !isLoading;
        reportFilterBuilderEl?.classList.toggle('is-loading', isLoading);
        reportFilterBuilderLoadingEl?.classList.toggle('visible', isLoading);
        if (reportClearFiltersBtn) reportClearFiltersBtn.disabled = isLoading;
        const submitBtn = reportForm?.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = isLoading;
    }

    function resetReportFilterBuilderState() {
        reportFiltersLoaded = false;
        reportFiltersLoadingPromise = null;
        reportFilterBuilderReady = false;
        reportFilterFields = getDefaultReportFields();
        reportFilterIdCounter = 0;
        reportFilterState = createReportFilterGroup(true);
        reportFilterState.rules.push(createReportRule());
        renderReportFilterBuilder();
        setReportFilterBuilderLoading(false);
    }

    function renderReportGroup(group, depth) {
        const wrapper = document.createElement('div');
        wrapper.className = `filter-builder-group ${depth > 0 ? 'group-nested' : ''}`;
        wrapper.dataset.groupId = group.id;

        const header = document.createElement('div');
        header.className = 'filter-builder-group-header';
        header.innerHTML = `
            <div class="filter-builder-group-title">
                <span>${group.isRoot ? 'Grupo principal' : 'Subgrupo'}</span>
                <div class="filter-builder-logic">
                    <button type="button" class="${group.condition === 'AND' ? 'active' : ''}" data-action="set-group-condition" data-group-id="${group.id}" data-condition="AND">E</button>
                    <button type="button" class="${group.condition === 'OR' ? 'active' : ''}" data-action="set-group-condition" data-group-id="${group.id}" data-condition="OR">OU</button>
                </div>
            </div>
            <div class="filter-builder-group-actions">
                <button type="button" class="builder-chip-btn" data-action="add-rule" data-group-id="${group.id}">+ Regra</button>
                <button type="button" class="builder-chip-btn" data-action="add-group" data-group-id="${group.id}">+ Grupo</button>
                ${group.isRoot ? '' : `<button type="button" class="builder-chip-btn danger" data-action="remove-item" data-item-id="${group.id}">Excluir grupo</button>`}
            </div>
        `;
        wrapper.appendChild(header);

        const rulesContainer = document.createElement('div');
        rulesContainer.className = 'filter-builder-rules';

        if (!group.rules.length) {
            const empty = document.createElement('div');
            empty.className = 'filter-builder-empty';
            empty.textContent = 'Este grupo ainda não possui regras.';
            rulesContainer.appendChild(empty);
        } else {
            group.rules.forEach(rule => {
                if (rule.type === 'group') {
                    rulesContainer.appendChild(renderReportGroup(rule, depth + 1));
                } else {
                    rulesContainer.appendChild(renderReportRule(rule));
                }
            });
        }

        wrapper.appendChild(rulesContainer);
        return wrapper;
    }

    function renderReportRule(rule) {
        const field = getReportFieldDefinition(rule.field);
        const operators = getOperatorOptionsForField(rule.field);
        const selectedOperator = operators.find(operator => operator.value === rule.operator) || operators[0];

        const row = document.createElement('div');
        row.className = 'filter-builder-rule';
        row.dataset.ruleId = rule.id;

        const fieldSelect = `
            <div class="filter-group">
                <label>Campo</label>
                <select class="form-control" data-action="change-rule-field" data-rule-id="${rule.id}">
                    ${reportFilterFields.map(item => `<option value="${item.id}" ${item.id === rule.field ? 'selected' : ''}>${item.label}</option>`).join('')}
                </select>
            </div>
        `;

        const operatorSelect = `
            <div class="filter-group">
                <label>Operador</label>
                <select class="form-control" data-action="change-rule-operator" data-rule-id="${rule.id}">
                    ${operators.map(item => `<option value="${item.value}" ${item.value === rule.operator ? 'selected' : ''}>${item.label}</option>`).join('')}
                </select>
            </div>
        `;

        const values = renderReportRuleInputs(rule, field, selectedOperator);
        const removeButton = `
            <div class="filter-group" style="flex: 0 0 auto;">
                <label>&nbsp;</label>
                <button type="button" class="builder-chip-btn danger" data-action="remove-item" data-item-id="${rule.id}">Excluir</button>
            </div>
        `;

        row.innerHTML = `${fieldSelect}${operatorSelect}${values}${removeButton}`;
        return row;
    }

    function renderReportRuleInputs(rule, field, operator) {
        if (!operator || operator.inputs === 0) {
            return `
                <div class="filter-group">
                    <label>Valor</label>
                    <div class="form-control" style="display:flex; align-items:center; color: var(--text-sec);">Sem valor</div>
                </div>
            `;
        }

        const dualClass = operator.inputs === 2 ? 'filter-builder-value-row dual' : 'filter-builder-value-row';
        return `
            <div class="filter-group">
                <label>Valor</label>
                <div class="${dualClass}">
                    ${renderReportRuleInput(rule, field, 'value', field.placeholder || 'Informe um valor')}
                    ${operator.inputs === 2 ? renderReportRuleInput(rule, field, 'valueTo', field.placeholder || 'Valor final') : ''}
                </div>
            </div>
        `;
    }

    function renderReportRuleInput(rule, field, key, placeholder) {
        const value = rule[key] || '';
        if (field.type === 'select') {
            return `
                <select class="form-control" data-action="change-rule-value" data-rule-id="${rule.id}" data-value-key="${key}">
                    <option value="">Selecione</option>
                    ${(field.options || []).map(option => `<option value="${option.value}" ${String(option.value) === String(value) ? 'selected' : ''}>${option.label}</option>`).join('')}
                </select>
            `;
        }

        if (field.type === 'date') {
            return `<input type="date" class="form-control" value="${value}" data-action="change-rule-value" data-rule-id="${rule.id}" data-value-key="${key}">`;
        }

        if (field.type === 'number') {
            return `<input type="number" class="form-control" step="0.01" placeholder="${placeholder}" value="${value}" data-action="change-rule-value" data-rule-id="${rule.id}" data-value-key="${key}">`;
        }

        return `<input type="text" class="form-control" placeholder="${placeholder}" value="${value}" data-action="change-rule-value" data-rule-id="${rule.id}" data-value-key="${key}">`;
    }

    function findReportNodeById(group, nodeId, parent = null) {
        if (group.id === nodeId) return { node: group, parent };
        for (const rule of group.rules) {
            if (rule.id === nodeId) return { node: rule, parent: group };
            if (rule.type === 'group') {
                const found = findReportNodeById(rule, nodeId, group);
                if (found) return found;
            }
        }
        return null;
    }

    function removeReportNode(nodeId) {
        const found = findReportNodeById(reportFilterState, nodeId);
        if (!found || !found.parent) return;
        found.parent.rules = found.parent.rules.filter(item => item.id !== nodeId);
        if (found.parent.isRoot && !found.parent.rules.length) {
            found.parent.rules.push(createReportRule());
        }
        renderReportFilterBuilder();
    }

    function serializeReportBuilderState(group = reportFilterState) {
        return {
            type: 'group',
            condition: group.condition === 'OR' ? 'OR' : 'AND',
            rules: (group.rules || []).map(rule => {
                if (rule.type === 'group') {
                    return serializeReportBuilderState(rule);
                }
                return {
                    type: 'rule',
                    field: rule.field,
                    operator: rule.operator,
                    value: rule.value || '',
                    valueTo: rule.valueTo || ''
                };
            })
        };
    }

    function restoreReportBuilderState(node, isRoot = true) {
        const group = createReportFilterGroup(isRoot);
        group.condition = node?.condition === 'OR' ? 'OR' : 'AND';
        const rawRules = Array.isArray(node?.rules) ? node.rules : [];
        group.rules = rawRules.map(item => {
            if (item?.type === 'group' || Array.isArray(item?.rules)) {
                return restoreReportBuilderState(item, false);
            }
            const rule = createReportRule(item?.field || reportFilterFields[0]?.id || 'cpf');
            rule.field = item?.field || rule.field;
            rule.operator = item?.operator || rule.operator;
            rule.value = item?.value || '';
            rule.valueTo = item?.valueTo || '';
            return rule;
        });
        if (!group.rules.length) {
            group.rules.push(createReportRule());
        }
        return group;
    }

    async function persistReportBuilderState() {
        try {
            await fetch('/api/relatorio_filters_state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ builder_state: serializeReportBuilderState() })
            });
        } catch (e) {
            console.error('Failed to save report filter state', e);
        }
    }

    function schedulePersistReportBuilderState() {
        if (reportFilterSaveTimeout) {
            clearTimeout(reportFilterSaveTimeout);
        }
        reportFilterSaveTimeout = setTimeout(() => {
            persistReportBuilderState();
        }, 400);
    }

    function getSerializableReportFilters(group = reportFilterState) {
        const rules = group.rules.map(rule => {
            if (rule.type === 'group') {
                const nested = getSerializableReportFilters(rule);
                return nested && nested.rules.length ? nested : null;
            }

            const field = getReportFieldDefinition(rule.field);
            const operator = getOperatorOptionsForField(rule.field).find(item => item.value === rule.operator);
            if (!field || !operator) return null;

            if (operator.inputs === 0) {
                return { field: rule.field, operator: rule.operator };
            }

            if (!rule.value) return null;

            if (operator.inputs === 2) {
                if (!rule.valueTo) return null;
                return { field: rule.field, operator: rule.operator, value: rule.value, value_to: rule.valueTo };
            }

            return { field: rule.field, operator: rule.operator, value: rule.value };
        }).filter(Boolean);

        return { condition: group.condition, rules };
    }

    resetReportFilterBuilderState();

    let reportHygienePreviewItems = [];
    let reportRecentHygieneCards = new Set();
    let reportHygieneSelection = new Set();
    let reportHygieneSecondStep = false;
    let reportHygieneProgressTimer = null;
    let reportHygieneStatusTimer = null;
    let reportHygieneIgnoreRecent = true;
    let reportHygieneCancelToken = null; // kept for legacy, now = job_id
    let reportHygieneJobId = null;        // DB-backed job identifier
    let reportHygieneIsProcessing = false;
    let reportHygieneFloatingTimer = null; // polling timer for floating popup
    let reportHygieneLastStatus = null;
    let reportHygieneFloatingRequested = false;
    let reportHygieneAdminpanelUsername = '';
    let reportHygieneAdminpanelPassword = '';

    function normalizeReportCardNumber(cardNumber) {
        return String(cardNumber || '').trim();
    }

    function isReportCardCurrentlyMarkedHygienized(cardNumber) {
        const normalizedCardNumber = normalizeReportCardNumber(cardNumber);
        if (!normalizedCardNumber) return false;
        if (reportRecentHygieneCards.has(normalizedCardNumber)) return true;
        const cards = document.querySelectorAll('#report-table-body .report-citizen-card');
        for (const card of cards) {
            const cardNumEl = card.querySelector('.rcc-card-number');
            if (!cardNumEl) continue;
            const cellText = (cardNumEl.textContent || '').replace(/\s+/g, ' ').trim();
            if (!cellText.includes(normalizedCardNumber)) continue;
            if (card.querySelector('.report-hygiene-return-badge')) {
                return true;
            }
        }
        return false;
    }

    function isAlreadyHygienizedPreviewItem(item) {
        return !!item?.higienizacao_historico || !!item?.higienizacao_recente || isReportCardCurrentlyMarkedHygienized(item?.cartao);
    }

    function ensureReportHygieneUi() {
        const actionsRow = document.getElementById('report-table-actions');
        const exportBtn = document.getElementById('btn-export-report');
        if (actionsRow && exportBtn && !document.getElementById('btn-report-hygiene')) {
            const hygieneBtn = document.createElement('button');
            hygieneBtn.type = 'button';
            hygieneBtn.id = 'btn-report-hygiene';
            hygieneBtn.className = 'btn-primary hidden';
            hygieneBtn.style.position = 'static';
            hygieneBtn.style.background = 'rgba(245, 158, 11, 0.14)';
            hygieneBtn.style.borderColor = 'rgba(245, 158, 11, 0.24)';
            hygieneBtn.style.color = '#fcd34d';
            hygieneBtn.style.boxShadow = 'none';
            hygieneBtn.style.padding = '8px 16px';
            hygieneBtn.style.fontSize = '0.9rem';
            hygieneBtn.style.height = 'auto';
            hygieneBtn.innerHTML = 'Higienização de Cadastro <i class="fa-solid fa-shield-heart" style="margin-left: 6px;"></i>';
            actionsRow.insertBefore(hygieneBtn, exportBtn);
        }

        if (!document.getElementById('report-hygiene-modal')) {
            const modal = document.createElement('div');
            modal.id = 'report-hygiene-modal';
            modal.className = 'modal-overlay hidden';
            modal.innerHTML = `
                <div class="modal-card glass-panel report-hygiene-modal-card">
                    <div class="modal-header report-hygiene-modal-header">
                        <h3>
                            <i class="fa-solid fa-triangle-exclamation" style="color: #F59E0B; margin-right:8px;"></i>
                            <span class="report-hygiene-title-text">
                                <span>Higienização de Cadastro</span>
                                <small>Melhoria de Dados em Andamento</small>
                            </span>
                        </h3>
                        <div class="report-hygiene-modal-actions">
                            <button class="modal-close" id="report-hygiene-minimize" title="Minimizar para o canto"><i class="fa-solid fa-window-minimize report-hygiene-minimize-icon"></i></button>
                            <button class="modal-close" id="report-hygiene-close" title="Fechar e/ou Cancelar"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    </div>
                    <div class="report-hygiene-modal-body">
                        <div class="report-hygiene-hero">
                            <div class="report-hygiene-hero-kicker">Fluxo protegido de restricao</div>
                            <div class="report-hygiene-hero-text">Revise o lote com calma, mantenha a observacao consistente e confirme a execucao apenas quando tudo estiver certo.</div>
                        </div>
                        <div class="alert-box report-hygiene-alert-box">
                            Esta é uma ação delicada. Os cartões selecionados entrarão em lista de restrição com motivo <strong>HIGIENIZAÇÃO DE CADASTRO</strong>.
                        </div>
                        <div>
                            <label style="display:block; font-weight:600; margin-bottom:8px;">Observação para o AdminPanel</label>
                            <textarea id="report-hygiene-observation" class="form-control" rows="5" maxlength="2000" placeholder="Escreva a observação que será adicionada ao cadastro no AdminPanel."></textarea>
                            <div class="text-muted" style="font-size:0.85rem; margin-top:6px;">O texto novo será inserido acima dos comentários antigos.</div>
                        </div>
                        <div class="report-hygiene-toolbar">
                            <div id="report-hygiene-count" class="text-muted">Carregando clientes elegíveis...</div>
                            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                                <label class="report-hygiene-toggle">
                                    <input type="checkbox" id="report-hygiene-ignore-recent" checked>
                                    <span>Ignorar já higienizados</span>
                                </label>
                                <button type="button" id="report-hygiene-select-all" class="btn-outline btn-sm">Marcar todos</button>
                                <button type="button" id="report-hygiene-select-none" class="btn-outline btn-sm">Desmarcar todos</button>
                            </div>
                        </div>
                        <div id="report-hygiene-list" class="report-hygiene-list-panel"></div>
                        <div id="report-hygiene-warning" class="hidden" style="padding: 14px 16px; border-radius: 12px; background: rgba(239, 68, 68, 0.10); border: 1px solid rgba(239, 68, 68, 0.25); color: #fecaca;">
                            Confirme novamente para executar a higienização dos clientes marcados.
                        </div>
                        <div id="report-hygiene-progress-wrap" class="report-hygiene-progress hidden">
                            <div class="report-hygiene-progress-head">
                                <div id="report-hygiene-progress-label" class="report-hygiene-progress-label">Preparando execução...</div>
                                <div id="report-hygiene-progress-pct" class="report-hygiene-progress-pct">0%</div>
                            </div>
                            <div class="report-hygiene-progress-track">
                                <div id="report-hygiene-progress-bar" class="report-hygiene-progress-bar"></div>
                            </div>
                            <div id="report-hygiene-progress-detail" class="report-hygiene-progress-detail">Assim que o AdminPanel avançar, esta barra acompanha o andamento.</div>
                        </div>
                        <div id="report-hygiene-error" class="login-error hidden"></div>
                        <div id="report-hygiene-result" class="hidden"></div>
                        <div class="report-hygiene-footer">
                            <button type="button" id="report-hygiene-export" class="btn-outline hidden"><i class="fa-solid fa-file-excel"></i> Exportar XLSX</button>
                            <button type="button" id="report-hygiene-cancel" class="btn-outline">Cancelar</button>
                            <button type="button" id="report-hygiene-step" class="btn-primary" style="position: static;">Revisar execução</button>
                            <button type="button" id="report-hygiene-confirm" class="btn-primary hidden" style="position: static; background:#dc2626; border-color:#dc2626;">Iniciar higienização</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            initReportHygieneDraggable();

            // Bind minimize dynamically when created
            const minimizeBtn = document.getElementById('report-hygiene-minimize');
            if (minimizeBtn) {
                minimizeBtn.addEventListener('click', () => {
                    const modal = document.getElementById('report-hygiene-modal');
                    if (modal?.classList.contains('is-minimized')) {
                        openReportHygieneModal();
                    } else {
                        minimizeReportHygieneModal();
                    }
                });
            }
        }

        if (!document.getElementById('report-hygiene-credentials-modal')) {
            const credentialModal = document.createElement('div');
            credentialModal.id = 'report-hygiene-credentials-modal';
            credentialModal.className = 'modal-overlay hidden';
            credentialModal.innerHTML = `
                <div class="modal-card glass-panel report-hygiene-credentials-card">
                    <div class="modal-header report-hygiene-modal-header">
                        <h3><i class="fa-solid fa-id-badge" style="color: #60A5FA; margin-right:8px;"></i> Credenciais do AdminPanel</h3>
                        <button class="modal-close" id="report-hygiene-credentials-close"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="report-hygiene-modal-body">
                        <div class="report-hygiene-hero report-hygiene-credentials-hero">
                            <div class="report-hygiene-hero-kicker">Autenticacao individual</div>
                            <div class="report-hygiene-hero-text">Use seu acesso pessoal do AdminPanel. A validacao acontece antes da revisao do lote.</div>
                        </div>
                        <div class="alert-box report-hygiene-credentials-alert">
                            Informe seu <strong>usuário</strong> e <strong>senha</strong> do AdminPanel para executar a higienização. Essas credenciais serão usadas apenas nesta execução.
                        </div>
                        <div class="report-hygiene-section">
                            <label style="display:block; font-weight:600; margin-bottom:8px;">Usuário do AdminPanel</label>
                            <input id="report-hygiene-adminpanel-username" type="text" class="form-control" autocomplete="username" placeholder="Digite seu usuário do AdminPanel">
                        </div>
                        <div class="report-hygiene-observation-block">
                            <label style="display:block; font-weight:600; margin-bottom:8px;">Senha do AdminPanel</label>
                            <input id="report-hygiene-adminpanel-password" type="password" class="form-control" autocomplete="current-password" placeholder="Digite sua senha do AdminPanel">
                        </div>
                        <div id="report-hygiene-credentials-error" class="login-error hidden"></div>
                        <div class="report-hygiene-footer">
                            <button type="button" id="report-hygiene-credentials-cancel" class="btn-outline">Cancelar</button>
                            <button type="button" id="report-hygiene-credentials-continue" class="btn-primary" style="position: static;">Continuar</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(credentialModal);
        }
    }

    function openReportHygieneModal() {
        const modal = document.getElementById('report-hygiene-modal');
        if (!modal) return;
        reportHygieneFloatingRequested = false;
        modal.classList.remove('is-minimized');
        updateReportHygieneMinimizeButton(false);
        const card = modal.querySelector('.report-hygiene-modal-card');
        if (card) {
            card.classList.remove('is-dragging');
            card.style.left = '';
            card.style.top = '';
            card.style.right = '';
            card.style.bottom = '';
        }
        modal.classList.remove('hidden');
        requestAnimationFrame(() => modal.classList.add('show'));
        hideHygieneFloatingPopup();
    }

    function minimizeReportHygieneModal() {
        reportHygieneFloatingRequested = true;
        const modal = document.getElementById('report-hygiene-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('show', 'is-minimized');
        const card = modal.querySelector('.report-hygiene-modal-card');
        if (card && !card.style.left && !card.style.top) {
            card.style.left = '';
            card.style.top = '';
            card.style.right = '';
            card.style.bottom = '';
        }
        updateReportHygieneMinimizeButton(true);
        hideHygieneFloatingPopup();
    }

    function updateReportHygieneMinimizeButton(isMinimized) {
        const btn = document.getElementById('report-hygiene-minimize');
        if (!btn) return;
        if (isMinimized) {
            btn.title = 'Expandir';
            btn.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i>';
        } else {
            btn.title = 'Minimizar para o canto';
            btn.innerHTML = '<i class="fa-solid fa-window-minimize report-hygiene-minimize-icon"></i>';
        }
    }

    function initReportHygieneDraggable() {
        const modal = document.getElementById('report-hygiene-modal');
        const card = modal?.querySelector('.report-hygiene-modal-card');
        const header = modal?.querySelector('.report-hygiene-modal-header');
        if (!modal || !card || !header || header.dataset.dragReady === 'true') return;
        header.dataset.dragReady = 'true';

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

        header.addEventListener('mousedown', (event) => {
            if (!modal.classList.contains('is-minimized')) return;
            if (event.target.closest('button')) return;

            const rect = card.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;

            card.style.right = 'auto';
            card.style.bottom = 'auto';
            card.style.left = `${rect.left}px`;
            card.style.top = `${rect.top}px`;
            card.classList.add('is-dragging');

            event.preventDefault();
        });

        document.addEventListener('mousemove', (event) => {
            if (!dragging) return;

            const maxLeft = window.innerWidth - card.offsetWidth - 8;
            const maxTop = window.innerHeight - card.offsetHeight - 8;
            const nextLeft = clamp(event.clientX - offsetX, 8, Math.max(8, maxLeft));
            const nextTop = clamp(event.clientY - offsetY, 8, Math.max(8, maxTop));

            card.style.right = 'auto';
            card.style.bottom = 'auto';
            card.style.left = `${nextLeft}px`;
            card.style.top = `${nextTop}px`;
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            card.classList.remove('is-dragging');
        });
    }

    function openReportHygieneCredentialsModal() {
        const modal = document.getElementById('report-hygiene-credentials-modal');
        if (!modal) return;
        const errorEl = document.getElementById('report-hygiene-credentials-error');
        const userInput = document.getElementById('report-hygiene-adminpanel-username');
        const passwordInput = document.getElementById('report-hygiene-adminpanel-password');
        if (errorEl) errorEl.classList.add('hidden');
        if (userInput) userInput.value = '';
        if (passwordInput) passwordInput.value = '';
        reportHygieneAdminpanelUsername = '';
        reportHygieneAdminpanelPassword = '';
        modal.classList.remove('hidden');
        requestAnimationFrame(() => {
            modal.classList.add('show');
            userInput?.focus();
        });
    }

    function closeReportHygieneCredentialsModal() {
        const modal = document.getElementById('report-hygiene-credentials-modal');
        if (!modal) return;
        modal.classList.remove('show');
        setTimeout(() => modal.classList.add('hidden'), 220);
    }

    async function markReportHygienePopupClosed(jobId) {
        if (!jobId || !currentUser) return;
        try {
            await fetch('/api/relatorio_higienizacao/popup/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId })
            });
        } catch {}
    }

    function closeReportHygieneModal() {
        const modal = document.getElementById('report-hygiene-modal');
        const jobId = reportHygieneJobId || reportHygieneCancelToken;
        const isMinimized = modal?.classList.contains('is-minimized');
        const isFinished = reportHygieneLastStatus && isFinishedHygieneStatus(reportHygieneLastStatus.status);

        if (jobId && (isMinimized || isFinished)) {
            reportHygieneFloatingRequested = false;
            if (reportHygieneStatusTimer) {
                clearInterval(reportHygieneStatusTimer);
                reportHygieneStatusTimer = null;
            }
            if (reportHygieneProgressTimer) {
                clearInterval(reportHygieneProgressTimer);
                reportHygieneProgressTimer = null;
            }
            hideReportHygieneModalImmediate();
            markReportHygienePopupClosed(jobId);
            if (isFinished) {
                reportHygieneJobId = null;
                reportHygieneCancelToken = null;
                reportHygieneIsProcessing = false;
            }
            return;
        }

        if (reportHygieneIsProcessing) {
            requestReportHygieneCancel();
            return;
        }
        if (!modal) return;
        resetReportHygieneSteps();
        modal.classList.remove('show', 'is-minimized');
        updateReportHygieneMinimizeButton(false);
        setTimeout(() => modal.classList.add('hidden'), 220);
    }

    async function requestReportHygieneCancel() {
        const jobId = reportHygieneJobId || reportHygieneCancelToken;
        if (!jobId) return;
        const cancelBtn = document.getElementById('report-hygiene-cancel');
        const errorEl = document.getElementById('report-hygiene-error');
        const progressLabel = document.getElementById('report-hygiene-progress-label');
        const progressDetail = document.getElementById('report-hygiene-progress-detail');
        const confirmBtn = document.getElementById('report-hygiene-confirm');
        if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelando...'; }
        if (confirmBtn) confirmBtn.disabled = true;
        if (progressDetail) progressDetail.textContent = 'Aguarde: o backend está encerrando a higienização no próximo ponto seguro.';
        try {
            await fetch('/api/relatorio_higienizacao/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId })
            });
        } catch (err) {
            if (errorEl) { errorEl.textContent = `Falha ao cancelar: ${err.message}`; errorEl.classList.remove('hidden'); }
        }
    }

    function resetReportHygieneSteps() {
        reportHygieneSecondStep = false;
        reportHygieneIsProcessing = false;
        reportHygieneCancelToken = null;
        reportHygieneJobId = null;
        if (reportHygieneProgressTimer) {
            clearInterval(reportHygieneProgressTimer);
            reportHygieneProgressTimer = null;
        }
        if (reportHygieneStatusTimer) {
            clearInterval(reportHygieneStatusTimer);
            reportHygieneStatusTimer = null;
        }
        stopHygieneFloatingPopup();
        document.getElementById('report-hygiene-warning')?.classList.add('hidden');
        document.getElementById('report-hygiene-confirm')?.classList.add('hidden');
        document.getElementById('report-hygiene-step')?.classList.remove('hidden');
        document.getElementById('report-hygiene-error')?.classList.add('hidden');
        document.getElementById('report-hygiene-result')?.classList.add('hidden');
        document.getElementById('report-hygiene-progress-wrap')?.classList.add('hidden');
        document.getElementById('report-hygiene-export')?.classList.add('hidden');
        const progressBar = document.getElementById('report-hygiene-progress-bar');
        const progressPct = document.getElementById('report-hygiene-progress-pct');
        const progressLabel = document.getElementById('report-hygiene-progress-label');
        const progressDetail = document.getElementById('report-hygiene-progress-detail');
        const cancelBtn = document.getElementById('report-hygiene-cancel');
        const resultEl = document.getElementById('report-hygiene-result');
        if (progressBar) progressBar.style.width = '0%';
        if (progressPct) progressPct.textContent = '0%';
        if (progressLabel) progressLabel.textContent = 'Preparando execução...';
        if (progressDetail) progressDetail.textContent = 'Assim que o AdminPanel avançar, esta barra acompanha o andamento.';
        if (resultEl) {
            resultEl.textContent = '';
            resultEl.className = 'hidden';
        }
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.textContent = 'Cancelar';
            cancelBtn.classList.remove('hidden');
        }
        setReportHygieneMode('review');
    }

    function setReportHygieneMode(mode) {
        const card = document.querySelector('#report-hygiene-modal .report-hygiene-modal-card');
        if (!card) return;
        card.classList.remove('is-review', 'is-processing', 'is-finished');
        if (mode === 'processing') {
            card.classList.add('is-processing');
            return;
        }
        if (mode === 'finished') {
            card.classList.add('is-finished');
            return;
        }
        card.classList.add('is-review');
    }

    function setReportHygieneResult(kind, message) {
        const resultEl = document.getElementById('report-hygiene-result');
        if (!resultEl) return;
        resultEl.className = `report-hygiene-result report-hygiene-result-${kind}`;
        resultEl.textContent = message || '';
    }

    function applyReportHygieneStatus(status) {
        const wrap = document.getElementById('report-hygiene-progress-wrap');
        const bar = document.getElementById('report-hygiene-progress-bar');
        const pct = document.getElementById('report-hygiene-progress-pct');
        const label = document.getElementById('report-hygiene-progress-label');
        const detail = document.getElementById('report-hygiene-progress-detail');
        if (!wrap || !bar || !pct || !label || !detail || !status) return;
        wrap.classList.remove('hidden');
        setReportHygieneMode(['success','partial','failed','cancelled'].includes(status.status) ? 'finished' : 'processing');
        const percent = Math.max(0, Math.min(100, Number(status.percent || 0)));
        bar.style.width = `${percent}%`;
        pct.textContent = `${percent}%`;
        label.textContent = status.label || 'Processando higienização...';
        detail.textContent = status.detail || 'O AdminPanel está executando as etapas do processamento.';
        const cancelBtn = document.getElementById('report-hygiene-cancel');
        if (cancelBtn) {
            const isFinished = isFinishedHygieneStatus(status.status);
            cancelBtn.classList.toggle('hidden', isFinished);
            if (!isFinished) {
                cancelBtn.disabled = false;
                cancelBtn.textContent = 'Cancelar';
            }
        }
    }

    function startReportHygieneStatusPolling(jobId) {
        if (!jobId) return;
        if (reportHygieneStatusTimer) {
            clearInterval(reportHygieneStatusTimer);
            reportHygieneStatusTimer = null;
        }

        const fetchStatus = async () => {
            if (!currentUser) {
                if (reportHygieneStatusTimer) {
                    clearInterval(reportHygieneStatusTimer);
                    reportHygieneStatusTimer = null;
                }
                return;
            }
            try {
                const res = await fetch(`/api/relatorio_higienizacao/status?job_id=${encodeURIComponent(jobId)}`);
                const payload = await res.json();
                if (!currentUser) return;
                if (!res.ok || !payload?.found) return;
                applyReportHygieneStatus(payload);
                updateHygieneFloatingPopup(payload);
                // Stop polling when job is finished
                if (['success','partial','failed','cancelled'].includes(payload.status)) {
                    clearInterval(reportHygieneStatusTimer);
                    reportHygieneStatusTimer = null;
                    reportHygieneIsProcessing = false;
                    // Persist result to floating popup until user dismisses
                    if (payload.status === 'success' || payload.status === 'partial') {
                        const r = payload.result || {};
                        finishReportHygieneProgress(r.success_count || 0, r.failure_count || 0);
                        if (payload.status === 'success') {
                            fetchReportData();
                            setReportHygieneResult('success', `${r.success_count || 0} cartão(ões) processado(s) com sucesso.`);
                        } else {
                            fetchReportData();
                            setReportHygieneResult('warn', `${r.success_count || 0} processado(s) e ${r.failure_count || 0} falha(s).`);
                        }
                    } else if (payload.status === 'cancelled') {
                        const progressLabel = document.getElementById('report-hygiene-progress-label');
                        const progressDetail = document.getElementById('report-hygiene-progress-detail');
                        if (progressLabel) progressLabel.textContent = 'Processamento cancelado';
                        if (progressDetail) progressDetail.textContent = 'A higienização foi interrompida a pedido do usuário.';
                        setReportHygieneResult('info', 'Cancelamento confirmado.');
                        fetchReportData();
                    } else {
                        // failed
                        const progressLabel = document.getElementById('report-hygiene-progress-label');
                        if (progressLabel) progressLabel.textContent = 'Falha no processamento';
                        setReportHygieneResult('error', 'Não foi possível concluir a higienização neste lote.');
                    }
                    // Keep the persisted job reference until the user dismisses the floating popup.
                    stopHygieneFloatingPopup();
                    const cancelBtn = document.getElementById('report-hygiene-cancel');
                    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.classList.add('hidden'); }
                    const exportBtn = document.getElementById('report-hygiene-export');
                    if (exportBtn && payload.job_id) { exportBtn.classList.remove('hidden'); exportBtn.dataset.jobId = payload.job_id; }
                    const confirmBtn = document.getElementById('report-hygiene-confirm');
                    if (confirmBtn) { confirmBtn.classList.add('hidden'); confirmBtn.disabled = false; confirmBtn.innerHTML = 'Iniciar higienização'; }
                    const stepBtn = document.getElementById('report-hygiene-step');
                    if (stepBtn) { stepBtn.classList.add('hidden'); stepBtn.disabled = false; }
                }
            } catch (error) {
                // silêncio
            }
        };

        fetchStatus();
        reportHygieneStatusTimer = setInterval(fetchStatus, 5000);
    }

    function startReportHygieneProgress(totalItems) {
        if (reportHygieneProgressTimer) {
            clearInterval(reportHygieneProgressTimer);
            reportHygieneProgressTimer = null;
        }

        const wrap = document.getElementById('report-hygiene-progress-wrap');
        const bar = document.getElementById('report-hygiene-progress-bar');
        const pct = document.getElementById('report-hygiene-progress-pct');
        const label = document.getElementById('report-hygiene-progress-label');
        const detail = document.getElementById('report-hygiene-progress-detail');
        if (!wrap || !bar || !pct || !label || !detail) return;

        let progress = 8;
        wrap.classList.remove('hidden');
        bar.style.width = `${progress}%`;
        pct.textContent = `${progress}%`;
        label.textContent = 'Iniciando higienização...';
        detail.textContent = `${totalItems} cliente(s) selecionado(s). A barra acompanhará as etapas reais do AdminPanel.`;
    }

    function finishReportHygieneProgress(successCount, failureCount) {
        if (reportHygieneProgressTimer) {
            clearInterval(reportHygieneProgressTimer);
            reportHygieneProgressTimer = null;
        }

        const wrap = document.getElementById('report-hygiene-progress-wrap');
        const bar = document.getElementById('report-hygiene-progress-bar');
        const pct = document.getElementById('report-hygiene-progress-pct');
        const label = document.getElementById('report-hygiene-progress-label');
        const detail = document.getElementById('report-hygiene-progress-detail');
        if (!wrap || !bar || !pct || !label || !detail) return;

        wrap.classList.remove('hidden');
        bar.style.width = '100%';
        pct.textContent = '100%';

        if (failureCount) {
            label.textContent = 'Processamento concluído com ressalvas';
            detail.textContent = `${successCount} cartão(ões) processado(s) e ${failureCount} falha(s).`;
            return;
        }

        label.textContent = 'Processamento concluído';
        detail.textContent = `${successCount} cartão(ões) processado(s) com sucesso.`;
    }

    function buildReportHygieneFailureMessage(failedItems) {
        if (!Array.isArray(failedItems) || !failedItems.length) {
            return '';
        }

        return failedItems.map((item, index) => {
            const nome = item?.nome || 'Cliente não identificado';
            const cartao = item?.cartao || '-';
            const motivo = item?.error || 'Falha sem detalhe retornado pelo backend.';
            return `${index + 1}. ${nome} | Cartão ${cartao}\n${motivo}`;
        }).join('\n\n');
    }

    function renderReportHygienePreviewList() {
        const listEl = document.getElementById('report-hygiene-list');
        const countEl = document.getElementById('report-hygiene-count');
        if (!listEl || !countEl) return;

        const visibleItems = reportHygienePreviewItems.filter(item => {
            if (!reportHygieneIgnoreRecent) return true;
            return !isAlreadyHygienizedPreviewItem(item);
        });

        if (!reportHygienePreviewItems.length) {
            listEl.innerHTML = '<div class="text-muted" style="padding: 24px; text-align:center;">Nenhum cliente elegível encontrado para este filtro.</div>';
            countEl.textContent = 'Nenhum cliente elegível';
            return;
        }

        const selectedCount = visibleItems.filter(item => reportHygieneSelection.has(normalizeReportCardNumber(item.cartao))).length;
        countEl.textContent = `${selectedCount} de ${visibleItems.length} cliente(s) marcados`;

        if (!visibleItems.length) {
            listEl.innerHTML = '<div class="text-muted" style="padding: 24px; text-align:center;">Todos os clientes encontrados neste lote já estão marcados como higienizados.</div>';
            return;
        }

        listEl.innerHTML = visibleItems.map(item => `
            <label style="display:flex; gap:12px; align-items:flex-start; padding:12px 10px; border-bottom:1px solid rgba(255,255,255,0.06); cursor:pointer;">
                <input type="checkbox" class="report-hygiene-item" value="${item.cartao}" ${reportHygieneSelection.has(normalizeReportCardNumber(item.cartao)) ? 'checked' : ''} style="margin-top:3px;">
                <div style="flex:1;">
                    <div style="font-weight:700; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <span>${item.nome || 'Não informado'}</span>
                        ${isAlreadyHygienizedPreviewItem(item) ? '<span class="report-hygiene-inline-badge"><i class="fa-solid fa-shield-heart"></i> Já higienizado</span>' : ''}
                    </div>
                    <div class="text-muted" style="font-size:0.85rem; margin-top:2px;">CPF: ${item.cpf || '-'} | Cartão: ${item.cartao}</div>
                    <div class="text-muted" style="font-size:0.8rem; margin-top:2px;">App ${item.app_id || '-'} · ${item.tipo_cartao || 'Tipo não informado'}</div>
                </div>
            </label>
        `).join('');

        listEl.querySelectorAll('.report-hygiene-item').forEach(input => {
            input.addEventListener('change', () => {
                if (input.checked) {
                    reportHygieneSelection.add(normalizeReportCardNumber(input.value));
                } else {
                    reportHygieneSelection.delete(normalizeReportCardNumber(input.value));
                }
                renderReportHygienePreviewList();
            });
        });
    }

    async function openReportHygienePreview() {
        const filters = getSerializableReportFilters();
        if (!filters?.rules?.length) {
            alert('Defina pelo menos um filtro antes de abrir a higienização de cadastro.');
            return;
        }

        ensureReportHygieneUi();
        resetReportHygieneSteps();
        reportHygieneIgnoreRecent = true;
        const ignoreRecentInput = document.getElementById('report-hygiene-ignore-recent');
        if (ignoreRecentInput) ignoreRecentInput.checked = true;
        document.getElementById('report-hygiene-observation').value = '';
        document.getElementById('report-hygiene-list').innerHTML = '<div class="text-muted" style="padding:24px;text-align:center;"><div class="modern-spinner" style="margin:0 auto 12px;"></div>Buscando clientes elegíveis...</div>';
        document.getElementById('report-hygiene-count').textContent = 'Carregando clientes elegíveis...';
        openReportHygieneModal();

        try {
            const res = await fetch('/api/relatorio_higienizacao/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filters })
            });
            const payload = await res.json();
            if (!res.ok) {
                throw new Error(payload.error || 'Não foi possível carregar os clientes elegíveis.');
            }
            reportHygienePreviewItems = payload.items || [];
            reportHygieneSelection = new Set(
                reportHygienePreviewItems
                    .filter(item => !isAlreadyHygienizedPreviewItem(item))
                    .map(item => normalizeReportCardNumber(item.cartao))
                    .filter(Boolean)
            );
            renderReportHygienePreviewList();
        } catch (error) {
            document.getElementById('report-hygiene-list').innerHTML = `<div class="text-danger" style="padding:24px;text-align:center;">${error.message}</div>`;
            document.getElementById('report-hygiene-count').textContent = 'Falha ao carregar clientes';
        }
    }

    function openReportHygieneFlowWithCredentials() {
        ensureReportHygieneUi();
        openReportHygieneCredentialsModal();
    }

    async function confirmReportHygieneProcess() {
        const observation = (document.getElementById('report-hygiene-observation')?.value || '').trim();
        const errorEl = document.getElementById('report-hygiene-error');
        const confirmBtn = document.getElementById('report-hygiene-confirm');
        const stepBtn = document.getElementById('report-hygiene-step');
        const filters = getSerializableReportFilters();

        errorEl.classList.add('hidden');

        if (!observation) {
            errorEl.textContent = 'Informe a observação que será enviada ao AdminPanel.';
            errorEl.classList.remove('hidden');
            return;
        }
        if (!reportHygieneSelection.size) {
            errorEl.textContent = 'Selecione pelo menos um cliente para processar.';
            errorEl.classList.remove('hidden');
            return;
        }
        if (!reportHygieneAdminpanelUsername || !reportHygieneAdminpanelPassword) {
            errorEl.textContent = 'Informe suas credenciais do AdminPanel antes de iniciar a higienização.';
            errorEl.classList.remove('hidden');
            return;
        }

        let selectedCards = [...reportHygieneSelection]
            .map(card => normalizeReportCardNumber(card))
            .filter(Boolean);
        if (reportHygieneIgnoreRecent) {
            const ignoredRecentCards = new Set(
                reportHygienePreviewItems
                    .filter(item => isAlreadyHygienizedPreviewItem(item))
                    .map(item => normalizeReportCardNumber(item.cartao))
                    .filter(Boolean)
            );
            selectedCards = selectedCards.filter(card => !ignoredRecentCards.has(card));
        }
        if (!selectedCards.length) {
            errorEl.textContent = 'Todos os cartões marcados foram ignorados por já estarem higienizados.';
            errorEl.classList.remove('hidden');
            return;
        }

        confirmBtn.disabled = true;
        stepBtn.disabled = true;
        reportHygieneIsProcessing = true;
        reportHygieneCancelToken = null; // no longer used as primary key
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processando...';
        setReportHygieneMode('processing');
        startReportHygieneProgress(selectedCards.length);

        try {
            const res = await fetch('/api/relatorio_higienizacao/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filters,
                    observation,
                    selected_cards: selectedCards,
                    adminpanel_username: reportHygieneAdminpanelUsername,
                    adminpanel_password: reportHygieneAdminpanelPassword,
                })
            });
            const payload = await res.json();
            if (!res.ok) {
                throw new Error(payload.error || 'Falha ao iniciar a higienização.');
            }

            // Server accepted the job and started it in background
            const jobId = payload.job_id;
            reportHygieneJobId = jobId;
            reportHygieneCancelToken = jobId; // shim
            reportHygieneLastStatus = {
                job_id: jobId,
                status: 'running',
                processed: 0,
                total: payload.total || selectedCards.length,
                percent: 2,
                label: 'Abrindo sessão do AdminPanel...',
                detail: 'Preparando o navegador para iniciar a higienização.',
            };

            if (reportHygieneFloatingRequested) {
                const modal = document.getElementById('report-hygiene-modal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('show', 'is-minimized');
                    updateReportHygieneMinimizeButton(true);
                }
                updateHygieneFloatingPopup(reportHygieneLastStatus);
            }

            // Poll DB for status updates
            startReportHygieneStatusPolling(jobId);

        } catch (error) {
            reportHygieneIsProcessing = false;
            reportHygieneJobId = null;
            if (reportHygieneStatusTimer) { clearInterval(reportHygieneStatusTimer); reportHygieneStatusTimer = null; }
            const progressWrap = document.getElementById('report-hygiene-progress-wrap');
            const progressLabelEl = document.getElementById('report-hygiene-progress-label');
            const progressDetailEl = document.getElementById('report-hygiene-progress-detail');
            if (progressWrap) progressWrap.classList.remove('hidden');
            if (progressLabelEl) progressLabelEl.textContent = 'Falha ao iniciar processamento';
            if (progressDetailEl) progressDetailEl.textContent = 'Verifique sua conexão e tente novamente.';
            setReportHygieneResult('error', 'Não foi possível iniciar a higienização neste lote.');
            errorEl.textContent = error.message;
            errorEl.classList.remove('hidden');
        } finally {
            confirmBtn.disabled = false;
            stepBtn.disabled = false;
            confirmBtn.innerHTML = 'Iniciar higienização';
        }
    }

    // ---------------------------------------------------------------------------
    // Floating popup — persists across tab navigation
    // ---------------------------------------------------------------------------

    function clearPersistedHygieneJob() {
        localStorage.removeItem('hygiene_job_id');
    }

    function hideReportHygieneModalImmediate() {
        const modal = document.getElementById('report-hygiene-modal');
        if (!modal) return;
        modal.classList.remove('show', 'is-minimized');
        modal.classList.add('hidden');
        updateReportHygieneMinimizeButton(false);
        const card = modal.querySelector('.report-hygiene-modal-card');
        if (card) {
            card.classList.remove('is-dragging');
            card.style.left = '';
            card.style.top = '';
            card.style.right = '';
            card.style.bottom = '';
        }
    }

    function clearHygieneSessionUi() {
        clearPersistedHygieneJob();
        reportHygieneJobId = null;
        reportHygieneCancelToken = null;
        reportHygieneIsProcessing = false;
        reportHygieneLastStatus = null;
        reportHygieneFloatingRequested = false;
        reportHygieneAdminpanelUsername = '';
        reportHygieneAdminpanelPassword = '';

        if (reportHygieneStatusTimer) {
            clearInterval(reportHygieneStatusTimer);
            reportHygieneStatusTimer = null;
        }
        if (reportHygieneProgressTimer) {
            clearInterval(reportHygieneProgressTimer);
            reportHygieneProgressTimer = null;
        }
        stopHygieneFloatingPopup();

        const popup = document.getElementById('hygiene-floating-popup');
        if (popup) {
            popup.classList.remove('hfp-visible', 'hfp-minimized', 'hfp-done');
            popup.classList.add('hfp-hidden');
        }
        hideReportHygieneModalImmediate();
    }

    function isFinishedHygieneStatus(status) {
        return ['success','partial','failed','cancelled'].includes(status);
    }

    function showHygieneFloatingPopup(jobId, total) {
        if (!currentUser) return;
        let popup = document.getElementById('hygiene-floating-popup');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'hygiene-floating-popup';
            popup.innerHTML = `
                <div class="hfp-header">
                    <span class="hfp-icon"><i class="fa-solid fa-shield-heart"></i></span>
                    <span class="hfp-heading">
                        <span class="hfp-title">Higienização de Cadastro</span>
                        <span class="hfp-subtitle">Execução em andamento</span>
                    </span>
                    <button id="hfp-dismiss" class="hfp-dismiss" title="Minimizar"><i class="fa-solid fa-chevron-down"></i></button>
                </div>
                <div class="hfp-counter" id="hfp-counter">Inicializando...</div>
                <div class="hfp-bar-wrap"><div class="hfp-bar" id="hfp-bar"></div></div>
                <div class="hfp-detail" id="hfp-detail"></div>
                <div class="hfp-actions">
                    <button id="hfp-cancel" class="btn-outline hfp-btn">Cancelar</button>
                    <button id="hfp-expand" class="btn-primary hfp-btn">Ver detalhes</button>
                </div>`;
            document.body.appendChild(popup);

            const dismissBtn = document.getElementById('hfp-dismiss');
            dismissBtn.addEventListener('click', () => {
                const isMin = popup.classList.toggle('hfp-minimized');
                if (isMin) {
                    dismissBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
                    dismissBtn.title = 'Expandir';
                } else {
                    dismissBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
                    dismissBtn.title = 'Minimizar';
                }
            });
            popup.addEventListener('click', (event) => {
                if (!popup.classList.contains('hfp-minimized')) return;
                if (event.target.closest('button')) return;
                popup.classList.remove('hfp-minimized');
                dismissBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
                dismissBtn.title = 'Minimizar';
            });
            document.getElementById('hfp-cancel').addEventListener('click', async () => {
                const btn = document.getElementById('hfp-cancel');
                if (btn) { btn.disabled = true; btn.textContent = 'Cancelando...'; }
                const jid = reportHygieneJobId;
                if (jid) {
                    await fetch('/api/relatorio_higienizacao/cancel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ job_id: jid })
                    });
                }
            });
            document.getElementById('hfp-expand').addEventListener('click', () => {
                ensureReportHygieneUi();
                openReportHygieneModal();
                reportHygieneFloatingRequested = false;
                hideHygieneFloatingPopup();
            });
        }
        popup.classList.remove('hfp-minimized', 'hfp-hidden', 'hfp-done');
        popup.style.borderColor = '';
        const oldClose = document.getElementById('hfp-close-done');
        if (oldClose) oldClose.remove();
        const cancelBtn = document.getElementById('hfp-cancel');
        if (cancelBtn) cancelBtn.style.display = 'inline-block';
        
        popup.classList.add('hfp-visible');
        if (total) document.getElementById('hfp-counter').textContent = `0 de ${total} cartões`;

    }

    function stopHygieneFloatingPopup() {
        if (reportHygieneFloatingTimer) {
            clearInterval(reportHygieneFloatingTimer);
            reportHygieneFloatingTimer = null;
        }
    }

    function hideHygieneFloatingPopup() {
        const popup = document.getElementById('hygiene-floating-popup');
        if (!popup) return;
        popup.classList.remove('hfp-visible', 'hfp-minimized');
        popup.classList.add('hfp-hidden');
    }

    function updateHygieneFloatingPopup(payload) {
        if (!currentUser) return;
        reportHygieneLastStatus = payload;
        if (reportHygieneFloatingRequested && reportHygieneJobId) {
            ensureReportHygieneUi();
            const modal = document.getElementById('report-hygiene-modal');
            if (modal && !modal.classList.contains('show')) {
                modal.classList.remove('hidden');
                modal.classList.add('show', 'is-minimized');
                updateReportHygieneMinimizeButton(true);
            }
        }
        const popup = document.getElementById('hygiene-floating-popup');
        if (!popup || !popup.classList.contains('hfp-visible')) return;
        
        const counter = document.getElementById('hfp-counter');
        const bar = document.getElementById('hfp-bar');
        const detail = document.getElementById('hfp-detail');
        const processed = payload.processed || 0;
        const total = payload.total || 0;
        
        const isDone = isFinishedHygieneStatus(payload.status);

        if (counter && !popup.classList.contains('hfp-done')) {
            if (isDone) {
                counter.textContent = payload.status === 'cancelled' ? 'Cancelado' :
                                      payload.status === 'failed' ? 'Falha no processamento' :
                                      `${processed} de ${total} − Concluído`;
            } else {
                counter.textContent = total ? `${processed} de ${total} cartões` : payload.label || '';
            }
        }
        
        if (bar && !popup.classList.contains('hfp-done')) bar.style.width = `${payload.percent || 0}%`;
        if (detail && !popup.classList.contains('hfp-done')) detail.textContent = payload.detail || '';
        
        if (isDone) {
            popup.classList.add('hfp-done');
            if (payload.status === 'failed' || payload.status === 'cancelled') {
                popup.style.borderColor = payload.status === 'cancelled' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(239, 68, 68, 0.3)';
            }
            
            const cancelBtn = document.getElementById('hfp-cancel');
            if (cancelBtn) cancelBtn.style.display = 'none';
            
            const actions = popup.querySelector('.hfp-actions');
            if (actions && !document.getElementById('hfp-close-done')) {
                const closeBtn = document.createElement('button');
                closeBtn.id = 'hfp-close-done';
                closeBtn.className = 'btn-outline hfp-btn';
                closeBtn.textContent = 'Fechar X';
                closeBtn.onclick = () => {
                    markReportHygienePopupClosed(reportHygieneJobId);
                    reportHygieneJobId = null;
                    reportHygieneCancelToken = null;
                    reportHygieneIsProcessing = false;
                    popup.classList.remove('hfp-visible');
                    popup.classList.add('hfp-hidden');
                };
                actions.insertBefore(closeBtn, actions.firstChild);
            }
        }
    }

    // Consulta o backend: o popup pertence ao usuário/lote, não ao navegador.
    async function reconnectActiveHygieneJobFromServer() {
        if (!currentUser) return;
        try {
            const res = await fetch('/api/relatorio_higienizacao/jobs/mine');
            const data = await res.json();
            if (!currentUser) return;
            if (!res.ok) return;

            const jobs = data.jobs || [];
            const visibleJob = jobs.find(job => Number(job.popup_should_show) === 1);
            const activeJob = jobs.find(job => !isFinishedHygieneStatus(job.status));
            const jobToShow = visibleJob || null;
            const jobToTrack = jobToShow || activeJob;
            if (!jobToTrack?.id) return;

            const statusRes = await fetch(`/api/relatorio_higienizacao/status?job_id=${encodeURIComponent(jobToTrack.id)}`);
            const statusData = await statusRes.json();
            if (!currentUser) return;
            if (!statusRes.ok || !statusData?.found) return;

            reportHygieneJobId = jobToTrack.id;
            reportHygieneCancelToken = jobToTrack.id;
            reportHygieneIsProcessing = !isFinishedHygieneStatus(statusData.status);

            if (jobToShow) {
                reportHygieneFloatingRequested = true;
                ensureReportHygieneUi();
                const modal = document.getElementById('report-hygiene-modal');
                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('show', 'is-minimized');
                    updateReportHygieneMinimizeButton(true);
                }
                applyReportHygieneStatus(statusData);
                updateHygieneFloatingPopup(statusData);
            }

            if (!isFinishedHygieneStatus(statusData.status) && jobToShow) {
                startReportHygieneStatusPolling(jobToTrack.id);
            }
        } catch {}
    }

    // Load filter options dynamically
    async function loadRelatorioFilters() {
        if (reportFiltersLoaded) return;
        if (reportFiltersLoadingPromise) return reportFiltersLoadingPromise;

        const defaultFields = getDefaultReportFields();
        setReportFilterBuilderLoading(true);
        reportFiltersLoadingPromise = (async () => {
            try {
            const res = await fetch('/api/relatorio_filters');
            const data = await res.json();
            const apps = (data.apps || []).map(app => ({
                value: String(app.id ?? app),
                label: app.label ? `${app.id} - ${app.label}` : String(app.id ?? app)
            }));
            const tipos = (data.tipos_cartao || []).map(tipo => ({ value: tipo, label: tipo }));

            const fields = defaultFields.map(field => {
                if (field.id === 'app_id') return { ...field, options: apps };
                if (field.id === 'tipo_cartao') return { ...field, options: tipos };
                return field;
            });
            updateReportFilterFields(fields);
            if (data.saved_filters) {
                reportFilterState = restoreReportBuilderState(data.saved_filters, true);
                normalizeReportGroup(reportFilterState);
                ensureReportBuilderHasRule();
                renderReportFilterBuilder();
            }
                reportFiltersLoaded = true;
            } catch (e) {
                console.error("Failed to load filter options", e);
                updateReportFilterFields(defaultFields);
            } finally {
                setReportFilterBuilderLoading(false);
                reportFiltersLoadingPromise = null;
            }
        })();

        return reportFiltersLoadingPromise;
    }

    if (reportForm) {
        ensureReportHygieneUi();
        reportFilterHelpBtn?.addEventListener('click', openReportFilterHelp);
        reportFilterHelpCloseBtn?.addEventListener('click', closeReportFilterHelp);
        reportFilterHelpModal?.addEventListener('click', (e) => {
            if (e.target === reportFilterHelpModal) closeReportFilterHelp();
        });

        reportForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!reportFilterBuilderReady) return;
            reportCurrentPage = 1;
            persistReportBuilderState();
            fetchReportData();
        });

        reportFilterBuilderEl?.addEventListener('click', (e) => {
            if (!reportFilterBuilderReady) return;
            const trigger = e.target.closest('[data-action]');
            if (!trigger) return;

            const action = trigger.dataset.action;
            if (action === 'add-rule') {
                const found = findReportNodeById(reportFilterState, trigger.dataset.groupId);
                if (found?.node?.type === 'group') {
                    found.node.rules.push(createReportRule());
                    renderReportFilterBuilder();
                    schedulePersistReportBuilderState();
                }
            }

            if (action === 'add-group') {
                const found = findReportNodeById(reportFilterState, trigger.dataset.groupId);
                if (found?.node?.type === 'group') {
                    const group = createReportFilterGroup();
                    group.rules.push(createReportRule());
                    found.node.rules.push(group);
                    renderReportFilterBuilder();
                    schedulePersistReportBuilderState();
                }
            }

            if (action === 'remove-item') {
                removeReportNode(trigger.dataset.itemId);
                schedulePersistReportBuilderState();
            }

            if (action === 'set-group-condition') {
                const found = findReportNodeById(reportFilterState, trigger.dataset.groupId);
                if (found?.node?.type === 'group') {
                    found.node.condition = trigger.dataset.condition === 'OR' ? 'OR' : 'AND';
                    renderReportFilterBuilder();
                    schedulePersistReportBuilderState();
                }
            }
        });

        reportFilterBuilderEl?.addEventListener('change', (e) => {
            if (!reportFilterBuilderReady) return;
            const trigger = e.target.closest('[data-action]');
            if (!trigger) return;

            const found = findReportNodeById(reportFilterState, trigger.dataset.ruleId);
            if (!found?.node || found.node.type !== 'rule') return;

            if (trigger.dataset.action === 'change-rule-field') {
                found.node.field = trigger.value;
                found.node.operator = getOperatorOptionsForField(trigger.value)[0].value;
                found.node.value = '';
                found.node.valueTo = '';
                renderReportFilterBuilder();
                schedulePersistReportBuilderState();
            }

            if (trigger.dataset.action === 'change-rule-operator') {
                found.node.operator = trigger.value;
                found.node.value = '';
                found.node.valueTo = '';
                renderReportFilterBuilder();
                schedulePersistReportBuilderState();
            }

            if (trigger.dataset.action === 'change-rule-value') {
                found.node[trigger.dataset.valueKey] = trigger.value;
                schedulePersistReportBuilderState();
            }
        });

        reportClearFiltersBtn?.addEventListener('click', () => {
            reportFilterState = createReportFilterGroup(true);
            reportFilterState.rules.push(createReportRule());
            renderReportFilterBuilder();
            schedulePersistReportBuilderState();
        });

        document.getElementById('btn-prev-page').addEventListener('click', () => {
            if (reportCurrentPage > 1) {
                reportCurrentPage--;
                fetchReportData();
            }
        });

        document.getElementById('btn-next-page').addEventListener('click', () => {
            reportCurrentPage++;
            fetchReportData();
        });

        // Sort chips
        document.querySelectorAll('.report-sort-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const field = btn.dataset.sort;
                if (reportSortBy === field) {
                    reportSortDir = reportSortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    reportSortBy = field;
                    reportSortDir = 'asc';
                }
                // Update chip UI
                document.querySelectorAll('.report-sort-chip').forEach(b => {
                    b.classList.remove('active');
                    b.querySelector('.sort-arrow')?.classList.add('fa-arrow-up');
                    b.querySelector('.sort-arrow')?.classList.remove('fa-arrow-down');
                });
                btn.classList.add('active');
                const arrow = btn.querySelector('.sort-arrow');
                if (arrow) {
                    arrow.classList.toggle('fa-arrow-up', reportSortDir === 'asc');
                    arrow.classList.toggle('fa-arrow-down', reportSortDir === 'desc');
                }
                reportCurrentPage = 1;
                fetchReportData();
            });
        });

        const btnExport = document.getElementById('btn-export-report');
        if (btnExport) {
            btnExport.addEventListener('click', (e) => {
                e.preventDefault();
                fetchReportData(true);
            });
        }

        const btnHygiene = document.getElementById('btn-report-hygiene');
        btnHygiene?.addEventListener('click', (e) => {
            e.preventDefault();
            openReportHygieneFlowWithCredentials();
        });

        document.getElementById('report-hygiene-close')?.addEventListener('click', closeReportHygieneModal);
        document.getElementById('report-hygiene-cancel')?.addEventListener('click', closeReportHygieneModal);
        document.getElementById('report-hygiene-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'report-hygiene-modal') closeReportHygieneModal();
        });
        document.getElementById('report-hygiene-credentials-close')?.addEventListener('click', closeReportHygieneCredentialsModal);
        document.getElementById('report-hygiene-credentials-cancel')?.addEventListener('click', closeReportHygieneCredentialsModal);
        document.getElementById('report-hygiene-credentials-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'report-hygiene-credentials-modal') closeReportHygieneCredentialsModal();
        });
        document.getElementById('report-hygiene-credentials-continue')?.addEventListener('click', async () => {
            const errorEl = document.getElementById('report-hygiene-credentials-error');
            const usernameInput = document.getElementById('report-hygiene-adminpanel-username');
            const passwordInput = document.getElementById('report-hygiene-adminpanel-password');
            const continueBtn = document.getElementById('report-hygiene-credentials-continue');
            const username = (usernameInput?.value || '').trim();
            const password = passwordInput?.value || '';

            if (errorEl) errorEl.classList.add('hidden');

            if (!username) {
                if (errorEl) {
                    errorEl.textContent = 'Informe o usuário do AdminPanel.';
                    errorEl.classList.remove('hidden');
                }
                usernameInput?.focus();
                return;
            }
            if (!password.trim()) {
                if (errorEl) {
                    errorEl.textContent = 'Informe a senha do AdminPanel.';
                    errorEl.classList.remove('hidden');
                }
                passwordInput?.focus();
                return;
            }

            if (continueBtn) {
                continueBtn.disabled = true;
                continueBtn.textContent = 'Validando...';
            }

            try {
                const response = await fetch('/api/relatorio_higienizacao/validate_adminpanel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        adminpanel_username: username,
                        adminpanel_password: password,
                    }),
                });
                const payload = await response.json().catch(() => ({}));
                if (!response.ok || payload?.ok === false) {
                    throw new Error(payload?.error || 'Nao foi possivel validar o acesso ao AdminPanel.');
                }

                reportHygieneAdminpanelUsername = username;
                reportHygieneAdminpanelPassword = password;
                closeReportHygieneCredentialsModal();
                await openReportHygienePreview();
            } catch (err) {
                if (errorEl) {
                    errorEl.textContent = err.message || 'Nao foi possivel validar o acesso ao AdminPanel.';
                    errorEl.classList.remove('hidden');
                }
            } finally {
                if (continueBtn) {
                    continueBtn.disabled = false;
                    continueBtn.textContent = 'Continuar';
                }
            }
        });
        document.getElementById('report-hygiene-select-all')?.addEventListener('click', () => {
            reportHygieneSelection = new Set(
                reportHygienePreviewItems
                    .filter(item => !reportHygieneIgnoreRecent || !isAlreadyHygienizedPreviewItem(item))
                    .map(item => normalizeReportCardNumber(item.cartao))
                    .filter(Boolean)
            );
            renderReportHygienePreviewList();
        });
        document.getElementById('report-hygiene-select-none')?.addEventListener('click', () => {
            reportHygieneSelection = new Set();
            renderReportHygienePreviewList();
        });
        document.getElementById('report-hygiene-ignore-recent')?.addEventListener('change', (e) => {
            reportHygieneIgnoreRecent = !!e.target.checked;
            if (reportHygieneIgnoreRecent) {
                reportHygienePreviewItems
                    .filter(item => isAlreadyHygienizedPreviewItem(item))
                    .forEach(item => reportHygieneSelection.delete(normalizeReportCardNumber(item.cartao)));
            }
            renderReportHygienePreviewList();
        });
        document.getElementById('report-hygiene-step')?.addEventListener('click', () => {
            const errorEl = document.getElementById('report-hygiene-error');
            const resultEl = document.getElementById('report-hygiene-result');
            errorEl.classList.add('hidden');
            if (resultEl) {
                resultEl.textContent = '';
                resultEl.className = 'hidden';
            }
            if (!(document.getElementById('report-hygiene-observation')?.value || '').trim()) {
                errorEl.textContent = 'Informe a observação antes de avançar.';
                errorEl.classList.remove('hidden');
                return;
            }
            if (!reportHygieneSelection.size) {
                errorEl.textContent = 'Selecione pelo menos um cliente antes de avançar.';
                errorEl.classList.remove('hidden');
                return;
            }
            reportHygieneSecondStep = true;
            const warningEl = document.getElementById('report-hygiene-warning');
            if (warningEl) {
                warningEl.textContent = 'Revise os clientes selecionados e clique em "Iniciar higienização" para continuar.';
                warningEl.classList.remove('hidden');
            }
            document.getElementById('report-hygiene-confirm')?.classList.remove('hidden');
            document.getElementById('report-hygiene-step')?.classList.add('hidden');
        });
        document.getElementById('report-hygiene-confirm')?.addEventListener('click', () => {
            confirmReportHygieneProcess();
        });
        document.getElementById('report-hygiene-export')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const jobId = btn?.dataset?.jobId || reportHygieneJobId;
            if (!jobId) {
                alert('Nenhum lote concluído disponível para exportação.');
                return;
            }
            await downloadFileFromUrl(
                `/api/relatorio_higienizacao/export_result?job_id=${encodeURIComponent(jobId)}`,
                btn,
                '<i class="fa-solid fa-file-excel"></i> Exportar XLSX',
                '<i class="fa-solid fa-spinner fa-spin"></i> Exportando...'
            );
        });
    }

    // Report Sub-Tabs Logic
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Update Active State
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Toggle Panes
            const target = btn.dataset.target;
            document.getElementById('content-geral').classList.toggle('hidden', target !== 'geral');
            document.getElementById('content-anomalias').classList.add('hidden'); // Always hide anomalies

            // Reset Table
            const reportBody = document.getElementById('report-table-body');
            if (reportBody) reportBody.innerHTML = '';
            document.getElementById('report-container')?.classList.add('hidden');
            document.getElementById('btn-export-report')?.classList.add('hidden');
            document.getElementById('btn-report-hygiene')?.classList.add('hidden');
            document.getElementById('btn-report-hygiene')?.classList.add('hidden');
        });
    });

    // Allows clicking a card to trigger single search globally
    window.viewCardDetails = function (cpf) {
        // Switch to Single Search Context
        document.getElementById('menu-analise').click();

        // Fill and Trigger
        const searchInput = document.getElementById('search-input-single');
        if (searchInput) {
            searchInput.value = cpf;
            document.getElementById('btn-search-single').click();
        }
    };

    async function fetchReportData(isExport = false) {
        const filters = getSerializableReportFilters();
        const data = {
            page: reportCurrentPage,
            per_page: 15,
            filters: filters?.rules?.length ? filters : null,
            export_excel: isExport,
            sort_by: reportSortBy,
            sort_dir: reportSortDir
        };

        const loader = document.getElementById('report-loader');
        const container = document.getElementById('report-container');
        const tbody = document.getElementById('report-table-body');

        const loaderText = loader.querySelector('.loader-text');
        if (loaderText) {
            loaderText.textContent = isExport ? "Gerando o arquivo, aguarde..." : "Buscando inteligência de dados...";
        }

        container.classList.add('hidden');
        loader.classList.remove('hidden');

        try {
            const res = await fetch('/api/relatorio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();

            if (res.ok) {
                if (isExport && result.download_url) {
                    window.location.href = `/download/${result.download_url}`;
                    loader.classList.add('hidden');
                    container.classList.remove('hidden');
                    return;
                }

                renderReportTable(result);
                const btnExport = document.getElementById('btn-export-report');
                const btnHygiene = document.getElementById('btn-report-hygiene');
                if (btnExport) {
                    if (result.total > 0) {
                        btnExport.classList.remove('hidden');
                    } else {
                        btnExport.classList.add('hidden');
                    }
                }
                if (btnHygiene) {
                    if (result.total > 0 && currentUser?.permissions?.higienizacao) {
                        btnHygiene.classList.remove('hidden');
                    } else {
                        btnHygiene.classList.add('hidden');
                    }
                }
            } else {
                tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Erro: ${result.error}</td></tr>`;
                container.classList.remove('hidden');
                document.getElementById('btn-export-report')?.classList.add('hidden');
                document.getElementById('btn-report-hygiene')?.classList.add('hidden');
                document.getElementById('btn-report-hygiene')?.classList.add('hidden');
            }
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Erro de Conexão.</td></tr>`;
            container.classList.remove('hidden');
            document.getElementById('btn-export-report')?.classList.add('hidden');
        } finally {
            loader.classList.add('hidden');
        }
    }

    function renderReportTable(result) {
        const tbody = document.getElementById('report-table-body');

        reportRecentHygieneCards = new Set(
            (result.data || [])
                .filter(row => !!row.higienizacao_recente)
                .map(row => normalizeReportCardNumber(row.cartao))
                .filter(Boolean)
        );

        if (!result.data || result.data.length === 0) {
            tbody.innerHTML = `<div style="text-align:center; padding: 48px 0; color: var(--text-sec);"><i class="fa-solid fa-folder-open" style="font-size:2.2rem; opacity:0.4; display:block; margin-bottom:12px;"></i>Nenhum registro encontrado com estes filtros.</div>`;
            document.getElementById('btn-next-page').disabled = true;
            document.getElementById('btn-prev-page').disabled = true;
            document.getElementById('report-pagination-info').textContent = 'Mostrando 0 de 0';
            document.getElementById('report-pagination-footer').textContent = 'Mostrando 0 de 0';
            document.getElementById('report-current-page').textContent = '0';
        } else {
            const ORIGIN_BADGE = {
                'ABT':        `<span class="badge" style="background:rgba(99,102,241,0.2);color:#818CF8;border:1px solid rgba(99,102,241,0.4);" title="Cadê meu ônibus recarga">ABT</span>`,
                'CLIENTE':    `<span class="badge" style="background:rgba(59,130,246,0.2);color:#60A5FA;border:1px solid rgba(59,130,246,0.4);" title="Portal Cliente">CLIENTE</span>`,
                'LEGACYDB_APP':`<span class="badge" style="background:rgba(236,72,153,0.2);color:#F472B6;border:1px solid rgba(236,72,153,0.4);" title="AdminPanel Web">LEGACYDB</span>`,
                'ESTUDANTE':  `<span class="badge" style="background:rgba(139,92,246,0.2);color:#A78BFA;border:1px solid rgba(139,92,246,0.4);" title="Portal Estudante">ESTUDANTE</span>`,
                'WIFI':       `<span class="badge" style="background:rgba(245,158,11,0.2);color:#FBBF24;border:1px solid rgba(245,158,11,0.4);" title="Wifi Max">WIFI</span>`,
                'WHATSAPP':   `<span class="badge" style="background:rgba(34,197,94,0.2);color:#4ADE80;border:1px solid rgba(34,197,94,0.4);" title="WhatsApp">WHATSAPP</span>`,
            };

            let html = '';
            result.data.forEach(row => {
                const nome = row.nome || 'NÃO INFORMADO';
                const originBadge = ORIGIN_BADGE[row.origem_contato] || '';

                const emailHtml = row.email
                    ? `<div class="rcc-contact-item"><i class="fa-regular fa-envelope"></i><span>${row.email}</span></div>`
                    : '';
                const celularHtml = row.celular
                    ? `<div class="rcc-contact-item"><i class="fa-solid fa-mobile-screen"></i><span>${row.celular}</span></div>`
                    : '';
                const contactBlock = (emailHtml || celularHtml)
                    ? emailHtml + celularHtml
                    : `<span style="color:var(--text-sec);opacity:0.5;font-size:0.8rem;">Sem contato</span>`;

                const saldoNum = typeof row.saldo === 'string' ? parseFloat(row.saldo) : (row.saldo ?? 0);
                const saldoFmt = saldoNum.toFixed(2).replace('.', ',');
                const saldoHtml = saldoNum > 0
                    ? `<span class="rcc-saldo positive">R$ ${saldoFmt}</span>`
                    : `<span class="rcc-saldo zero">R$ 0,00</span>`;

                const hygieneBadge = row.higienizacao_recente
                    ? `<span class="report-hygiene-return-badge" title="Higienizado nas últimas 24h"><i class="fa-solid fa-shield-heart"></i> Higienizado</span>`
                    : '';

                const ultUsoFmt = row.ultimo_uso
                    ? `<div class="rcc-date-row"><i class="fa-solid fa-clock-rotate-left"></i> Uso: ${row.ultimo_uso}</div>`
                    : '';
                const ultRecargaFmt = row.ultima_recarga
                    ? `<div class="rcc-date-row"><i class="fa-solid fa-bolt"></i> Recarga: ${row.ultima_recarga}</div>`
                    : '';

                let pendenteHtml = '';
                if (row.recarga_pendente) {
                    const pendValor = row.valor_recarga_pendente
                        ? `<span class="rcc-pendente-valor">R$ ${parseFloat(row.valor_recarga_pendente).toFixed(2).replace('.', ',')}</span>`
                        : '';
                    pendenteHtml = `<div class="rcc-date-row rcc-pendente-row"><i class="fa-solid fa-clock"></i> Pendente: ${row.recarga_pendente.split(' ')[0]} ${pendValor}</div>`;
                }

                let ultCompraHtml = '';
                if (row.ultima_compra_data) {
                    const isTransferCompra = row.ultima_compra_local === 'Transferência de Crédito';
                    const compraIcon = isTransferCompra ? 'fa-right-left' : 'fa-store';
                    const compraLabel = isTransferCompra ? 'Recarga' : 'Compra';
                    const compraLocal = row.ultima_compra_local ? ` — ${row.ultima_compra_local}` : '';
                    const compraValor = row.ultima_compra_valor != null
                        ? ` <span class="rcc-compra-valor">R$ ${parseFloat(row.ultima_compra_valor).toFixed(2).replace('.', ',')}</span>`
                        : '';
                    ultCompraHtml = `<div class="rcc-date-row rcc-compra-row"><i class="fa-solid ${compraIcon}"></i> ${compraLabel}: ${row.ultima_compra_data}${compraLocal}${compraValor}</div>`;
                }

                const cpfSafe = (row.cpf || row.cartao || '').replace(/'/g, "\\'");

                html += `
                <div class="report-citizen-card">
                    <div class="rcc-identity">
                        <div class="rcc-name">${nome}</div>
                        <div class="rcc-cpf"><i class="fa-regular fa-id-card"></i> ${row.cpf || '—'}</div>
                        <div class="rcc-badges">${originBadge}${hygieneBadge}</div>
                    </div>
                    <div class="rcc-contact">${contactBlock}</div>
                    <div class="rcc-card-info">
                        <div class="rcc-card-number"
                             onclick="viewCardDetails('${cpfSafe}')"
                             title="Ver detalhes">${row.cartao}</div>
                        <div class="rcc-dates">${ultUsoFmt}${ultRecargaFmt}${pendenteHtml}${ultCompraHtml}</div>
                    </div>
                    <div class="rcc-right">
                        ${saldoHtml}
                        <span class="rcc-app-id">App ${row.app_id}</span>
                    </div>
                </div>`;
            });
            tbody.innerHTML = html;

            // Pagination Update
            const paginationText = `Total: ${result.total.toLocaleString('pt-BR')} registros (Pág. ${result.page} de ${result.total_pages})`;
            document.getElementById('report-pagination-info').textContent = paginationText;
            document.getElementById('report-pagination-footer').textContent = paginationText;
            document.getElementById('report-current-page').textContent = result.page;

            document.getElementById('btn-prev-page').disabled = result.page <= 1;
            document.getElementById('btn-next-page').disabled = result.page >= result.total_pages;
        }

        document.getElementById('report-container').classList.remove('hidden');
    }

    // ===========================
    //  ADMIN PANEL LOGIC
    // ===========================

    function ensureAdminHygienePermissionUI() {
        const adminHeaderRow = document.querySelector('#admin-users-table thead tr');
        if (adminHeaderRow && !document.getElementById('admin-header-higienizacao')) {
            const th = document.createElement('th');
            th.id = 'admin-header-higienizacao';
            th.textContent = 'Higienização';
            const loginHeader = [...adminHeaderRow.querySelectorAll('th')].find(el => el.textContent.includes('Login'));
            if (loginHeader) {
                adminHeaderRow.insertBefore(th, loginHeader);
            } else {
                adminHeaderRow.appendChild(th);
            }
        }

        if (!document.getElementById('modal-perm-higienizacao')) {
            const permGrid = document.querySelector('#user-form .perm-grid');
            const relatorioToggle = document.getElementById('modal-perm-relatorio')?.closest('.perm-toggle');
            if (permGrid && relatorioToggle) {
                const wrapper = document.createElement('label');
                wrapper.className = 'perm-toggle';
                wrapper.innerHTML = `
                    <input type="checkbox" id="modal-perm-higienizacao">
                    <span class="toggle-slider"></span>
                    <span class="toggle-label"><i class="fa-solid fa-shield-heart"></i> Higienização</span>
                `;
                permGrid.insertBefore(wrapper, relatorioToggle.nextSibling);
            }
        }
    }

    async function loadAdminUsers() {
        const tbody = document.getElementById('admin-users-body');
        if (!tbody) return;
        ensureAdminHygienePermissionUI();
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:40px;"><div class="modern-spinner" style="margin:0 auto 16px;"></div>Carregando usuários...</td></tr>';

        try {
            const res = await fetch('/api/admin/users');
            if (!res.ok) { tbody.innerHTML = '<tr><td colspan="9">Erro ao carregar</td></tr>'; return; }
            const data = await res.json();
            renderAdminUsers(data.users);
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="9">Erro de conexão</td></tr>';
        }
    }

    function renderAdminUsers(users) {
        const tbody = document.getElementById('admin-users-body');
        if (!users || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;">Nenhum usuário encontrado</td></tr>';
            return;
        }
        tbody.innerHTML = users.map(u => {
            const permPill = (val) => val ? '<span class="perm-pill on"><i class="fa-solid fa-check"></i></span>' : '<span class="perm-pill off"><i class="fa-solid fa-xmark"></i></span>';
            return `
                <tr>
                    <td><strong>${u.username}</strong></td>
                    <td class="text-muted">${u.email || '-'}</td>
                    <td><span class="admin-badge ${u.is_admin ? 'yes' : 'no'}">${u.is_admin ? 'Admin' : 'Usuário'}</span></td>
                    <td>${permPill(u.perm_dashboard)}</td>
                    <td>${permPill(u.perm_analise)}</td>
                    <td>${permPill(u.perm_cruzamento)}</td>
                    <td>${permPill(u.perm_relatorio)}</td>
                    <td class="text-muted" style="font-size:0.85rem;">${u.last_login || 'Nunca'}</td>
                    <td>
                        <div class="action-btns">
                            <button class="action-btn" title="Editar" onclick="window._adminEdit(${u.id})"><i class="fa-solid fa-pen"></i></button>
                            <button class="action-btn" title="Resetar Senha" onclick="window._adminResetPw(${u.id}, '${u.username}')"><i class="fa-solid fa-key"></i></button>
                            <button class="action-btn danger" title="Excluir" onclick="window._adminDelete(${u.id}, '${u.username}')"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Store users for edit lookup
    let adminUsersList = [];

    async function loadAndStoreUsers() {
        try {
            const res = await fetch('/api/admin/users');
            if (res.ok) {
                const data = await res.json();
                adminUsersList = data.users;
                renderAdminUsers(adminUsersList);
            } else {
                const tbody = document.getElementById('admin-users-body');
                if (tbody) {
                    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;">Erro ao carregar usuários</td></tr>';
                }
            }
        } catch (e) {
            const tbody = document.getElementById('admin-users-body');
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;">Erro de conexão</td></tr>';
            }
        }
    }

    // Modal helpers
    function openModal(id) {
        const modal = document.getElementById(id);
        modal.classList.remove('hidden');
        requestAnimationFrame(() => modal.classList.add('show'));
    }
    function closeModal(id) {
        const modal = document.getElementById(id);
        modal.classList.remove('show');
        setTimeout(() => modal.classList.add('hidden'), 250);
    }

    // Create User button
    document.getElementById('btn-add-user')?.addEventListener('click', () => {
        document.getElementById('modal-title').innerHTML = '<i class="fa-solid fa-user-plus" style="color:var(--accent-primary);margin-right:8px;"></i> Novo Usuário';
        document.getElementById('modal-user-id').value = '';
        document.getElementById('modal-username').value = '';
        document.getElementById('modal-username').disabled = false;
        document.getElementById('modal-email').value = '';
        document.getElementById('modal-password').value = '';
        document.getElementById('modal-password-group').style.display = '';
        document.getElementById('modal-perm-admin').checked = false;
        document.getElementById('modal-perm-dashboard').checked = true;
        document.getElementById('modal-perm-analise').checked = true;
        document.getElementById('modal-perm-cruzamento').checked = true;
        document.getElementById('modal-perm-relatorio').checked = true;
        if (document.getElementById('modal-perm-higienizacao')) {
            document.getElementById('modal-perm-higienizacao').checked = false;
        }
        document.getElementById('modal-error').classList.add('hidden');
        document.getElementById('modal-submit-btn').textContent = 'Criar Usuário';
        openModal('user-modal');
    });

    // Close modals
    document.getElementById('modal-close')?.addEventListener('click', () => closeModal('user-modal'));
    document.getElementById('reset-pw-close')?.addEventListener('click', () => closeModal('reset-pw-modal'));

    // Close on backdrop click
    document.getElementById('user-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'user-modal') closeModal('user-modal');
    });
    document.getElementById('reset-pw-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'reset-pw-modal') closeModal('reset-pw-modal');
    });

    // User form submit (create or update)
    document.getElementById('user-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('modal-error');
        errorEl.classList.add('hidden');
        const userId = document.getElementById('modal-user-id').value;
        const isEdit = !!userId;

        const body = {
            username: document.getElementById('modal-username').value.trim(),
            email: document.getElementById('modal-email').value.trim(),
            is_admin: document.getElementById('modal-perm-admin').checked ? 1 : 0,
            perm_dashboard: document.getElementById('modal-perm-dashboard').checked ? 1 : 0,
            perm_analise: document.getElementById('modal-perm-analise').checked ? 1 : 0,
            perm_cruzamento: document.getElementById('modal-perm-cruzamento').checked ? 1 : 0,
            perm_relatorio: document.getElementById('modal-perm-relatorio').checked ? 1 : 0,
            perm_higienizacao: document.getElementById('modal-perm-higienizacao')?.checked ? 1 : 0,
        };
        if (!isEdit) {
            body.password = document.getElementById('modal-password').value;
        }

        try {
            const url = isEdit ? `/api/admin/users/${userId}` : '/api/admin/users';
            const method = isEdit ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) {
                errorEl.textContent = data.error || 'Erro ao salvar';
                errorEl.classList.remove('hidden');
                return;
            }
            closeModal('user-modal');
            loadAndStoreUsers();
        } catch (err) {
            errorEl.textContent = 'Erro de conexão';
            errorEl.classList.remove('hidden');
        }
    });

    // Reset Password form
    document.getElementById('reset-pw-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('reset-pw-error');
        errorEl.classList.add('hidden');
        const userId = document.getElementById('reset-pw-user-id').value;
        const password = document.getElementById('reset-pw-password').value;

        try {
            const res = await fetch(`/api/admin/users/${userId}/reset_password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (!res.ok) {
                errorEl.textContent = data.error || 'Erro ao resetar';
                errorEl.classList.remove('hidden');
                return;
            }
            closeModal('reset-pw-modal');
        } catch (err) {
            errorEl.textContent = 'Erro de conexão';
            errorEl.classList.remove('hidden');
        }
    });

    // Global functions for inline onclick in table rows
    window._adminEdit = async function (userId) {
        // Fetch fresh user data
        try {
            const res = await fetch('/api/admin/users');
            if (!res.ok) return;
            const data = await res.json();
            const user = data.users.find(u => u.id === userId);
            if (!user) return;

            document.getElementById('modal-title').innerHTML = '<i class="fa-solid fa-user-pen" style="color:var(--accent-primary);margin-right:8px;"></i> Editar Usuário';
            document.getElementById('modal-user-id').value = user.id;
            document.getElementById('modal-username').value = user.username;
            document.getElementById('modal-username').disabled = true;
            document.getElementById('modal-email').value = user.email || '';
            document.getElementById('modal-password-group').style.display = 'none';
            document.getElementById('modal-perm-admin').checked = !!user.is_admin;
            document.getElementById('modal-perm-dashboard').checked = !!user.perm_dashboard;
            document.getElementById('modal-perm-analise').checked = !!user.perm_analise;
            document.getElementById('modal-perm-cruzamento').checked = !!user.perm_cruzamento;
            document.getElementById('modal-perm-relatorio').checked = !!user.perm_relatorio;
            if (document.getElementById('modal-perm-higienizacao')) {
                document.getElementById('modal-perm-higienizacao').checked = !!user.perm_higienizacao;
            }
            document.getElementById('modal-error').classList.add('hidden');
            document.getElementById('modal-submit-btn').textContent = 'Salvar Alterações';
            openModal('user-modal');
        } catch (e) { }
    };

    window._adminResetPw = function (userId, username) {
        document.getElementById('reset-pw-user-id').value = userId;
        document.getElementById('reset-pw-username').textContent = username;
        document.getElementById('reset-pw-password').value = '';
        document.getElementById('reset-pw-error').classList.add('hidden');
        openModal('reset-pw-modal');
    };

    window._adminDelete = async function (userId, username) {
        if (!confirm(`Tem certeza que deseja excluir o usuário "${username}"?`)) return;
        try {
            const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) {
                alert(data.error || 'Erro ao excluir');
                return;
            }
            loadAndStoreUsers();
        } catch (e) {
            alert('Erro de conexão');
        }
    };

    // Override admin rendering to inject the hygiene permission without relying on old template markup
    function renderAdminUsers(users) {
        const tbody = document.getElementById('admin-users-body');
        if (!tbody) return;
        ensureAdminHygienePermissionUI();

        if (!users || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;">Nenhum usuário encontrado</td></tr>';
            return;
        }

        const permPill = (val) => val
            ? '<span class="perm-pill on"><i class="fa-solid fa-check"></i></span>'
            : '<span class="perm-pill off"><i class="fa-solid fa-xmark"></i></span>';

        tbody.innerHTML = users.map(u => `
            <tr>
                <td><strong>${u.username}</strong></td>
                <td class="text-muted">${u.email || '-'}</td>
                <td><span class="admin-badge ${u.is_admin ? 'yes' : 'no'}">${u.is_admin ? 'Admin' : 'Usuário'}</span></td>
                <td>${permPill(u.perm_dashboard)}</td>
                <td>${permPill(u.perm_analise)}</td>
                <td>${permPill(u.perm_cruzamento)}</td>
                <td>${permPill(u.perm_relatorio)}</td>
                <td>${permPill(u.perm_higienizacao)}</td>
                <td class="text-muted" style="font-size:0.85rem;">${u.last_login || 'Nunca'}</td>
                <td>
                    <div class="action-btns">
                        <button class="action-btn" title="Editar" onclick="window._adminEdit(${u.id})"><i class="fa-solid fa-pen"></i></button>
                        <button class="action-btn" title="Resetar Senha" onclick="window._adminResetPw(${u.id}, '${u.username}')"><i class="fa-solid fa-key"></i></button>
                        <button class="action-btn danger" title="Excluir" onclick="window._adminDelete(${u.id}, '${u.username}')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    // Override loadAdminUsers to also store
    async function loadAdminUsers() {
        const tbody = document.getElementById('admin-users-body');
        if (!tbody) return;
        ensureAdminHygienePermissionUI();
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:40px;"><div class="modern-spinner" style="margin:0 auto 16px;"></div>Carregando usuários...</td></tr>';
        await loadAndStoreUsers();
    }

    // ===========================
    //  SIDEBAR PIN TOGGLE
    // ===========================
    const sidebar = document.getElementById('sidebar');
    const sidebarPinBtn = document.getElementById('sidebar-pin-btn');

    if (sidebarPinBtn && sidebar) {
        const pinKey = 'sidebar_pinned';
        if (localStorage.getItem(pinKey) === '1') sidebar.classList.add('pinned');

        sidebarPinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('pinned');
            localStorage.setItem(pinKey, sidebar.classList.contains('pinned') ? '1' : '0');
        });
    }

    // Resize Chart.js charts after sidebar CSS transition ends
    if (sidebar) {
        sidebar.addEventListener('transitionend', (e) => {
            if (e.propertyName !== 'width') return;
            document.querySelectorAll('canvas').forEach(canvas => {
                const chart = Chart.getChart(canvas);
                if (chart) chart.resize();
            });
        });
    }

    // ===========================
    //  BOTTOM NAV (mobile)
    // ===========================
    function syncBottomNav(targetId) {
        document.querySelectorAll('.bn-item').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-target') === targetId);
        });
    }

    document.querySelectorAll('.bn-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = btn.getAttribute('data-target');
            if (!targetId) return;

            if (targetId === 'admin-view' && (!currentUser || !currentUser.is_admin)) return;
            if (targetId === 'hygiene-history-view' && (!currentUser || (currentUser.is_admin !== true && currentUser.permissions?.higienizacao !== true))) return;

            // Reuse main nav logic
            const mainNavItem = document.querySelector(`.nav-item[data-target="${targetId}"]`);
            if (mainNavItem) mainNavItem.click();
            else {
                // fallback: manually switch view
                document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
                const target = document.getElementById(targetId);
                if (target) target.classList.remove('hidden');
            }
            syncBottomNav(targetId);
        });
    });

    // Keep bottom nav in sync when sidebar nav is used
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const targetId = item.getAttribute('data-target');
            if (targetId) syncBottomNav(targetId);
        });
    });

    // (dashboard-panels-grid usa flex column simples — sem lógica de grid dinâmico)

    // ===========================
    //  DASHBOARD DATE HEADER
    // ===========================
    const dthDate = document.getElementById('dth-date');
    if (dthDate) {
        const now = new Date();
        const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
        dthDate.innerHTML = now.toLocaleDateString('pt-BR', opts);
    }

    // ===========================
    //  AUTO-UPDATE CHECK
    // ===========================
    (function startVersionPoller() {
        let updateBannerShown = false;

        async function checkVersion() {
            if (updateBannerShown) return;
            try {
                const res = await fetch('/api/version');
                if (!res.ok) return;
                const { build_id } = await res.json();
                if (build_id !== window.__BUILD_ID__) {
                    showUpdateBanner();
                }
            } catch (e) { /* servidor offline ou reiniciando */ }
        }

        function showUpdateBanner() {
            if (updateBannerShown) return;
            updateBannerShown = true;

            const banner = document.createElement('div');
            banner.id = 'update-banner';
            banner.innerHTML = `
                <div class="update-banner-inner">
                    <i class="fa-solid fa-rotate update-banner-icon"></i>
                    <span>Nova versão disponível — recarregando em <strong id="update-countdown">10</strong>s</span>
                    <button class="update-banner-btn" onclick="location.reload()">Recarregar agora</button>
                </div>`;
            document.body.appendChild(banner);

            let count = 10;
            const timer = setInterval(() => {
                count--;
                const el = document.getElementById('update-countdown');
                if (el) el.textContent = count;
                if (count <= 0) {
                    clearInterval(timer);
                    location.reload();
                }
            }, 1000);
        }

        setInterval(checkVersion, 30000);
    })();

    // ===========================
    //  INIT
    // ===========================
    currentUser = window.__CURRENT_USER__ || null;
    if (currentUser) {
        initApp();
    } else {
        window.location.href = '/';
    }

});

