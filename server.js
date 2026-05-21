const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const ws = require('ws');
const fs = require('fs');
const path = require('path');
const localtunnel = require('localtunnel');
const { spawn, exec } = require('child_process');

// Path to Antigravity's binary
const LS_BINARY = "C:\\Users\\thiag\\AppData\\Local\\Programs\\Antigravity 2.0\\resources\\bin\\language_server.exe";

class ArcServer {
    constructor(config) {
        this.port = config.port || 9090;
        this.sessionToken = config.token;
        this.usePublic = config.public || false;
        this.targetPort = null;
        this.targetCsrf = null;
        this.lsProcess = null;
        this.proxy = null;
        this.server = null;
        this.wsServer = null;
        this.clients = new Set();
        this.isShuttingDown = false;
    }

    async start() {
        console.log('\x1b[90m[ARC] Inicializando servidor de control remoto...\x1b[0m');
        
        // 1. Discover or Spawn Antigravity LS
        await this.setupTarget();

        // 2. Setup Express & Proxy
        const app = express();
        app.use(express.urlencoded({ extended: true }));

        this.proxy = httpProxy.createProxyServer({
            target: `http://127.0.0.1:${this.targetPort}`,
            ws: true,
            changeOrigin: true
        });

        // Rewrite Origin and Referer headers on ALL proxied HTTP requests.
        // The Language Server validates Origin/Host against localhost and rejects
        // requests from external domains (like localtunnel's *.loca.lt),
        // causing connection-level failures that surface as 502 Bad Gateway.
        this.proxy.on('proxyReq', (proxyReq, req, res) => {
            const targetOrigin = `http://127.0.0.1:${this.targetPort}`;

            // Remove external proxy headers that trigger DNS rebinding protection
            proxyReq.removeHeader('x-forwarded-host');
            proxyReq.removeHeader('x-forwarded-for');
            proxyReq.removeHeader('x-forwarded-proto');
            proxyReq.removeHeader('forwarded');

            if (req.headers.origin) {
                proxyReq.setHeader('origin', targetOrigin);
            }

            if (req.headers.referer) {
                try {
                    const refUrl = new URL(req.headers.referer);
                    refUrl.host = `127.0.0.1:${this.targetPort}`;
                    refUrl.protocol = 'http:';
                    proxyReq.setHeader('referer', refUrl.toString());
                } catch (e) {
                    proxyReq.setHeader('referer', targetOrigin + '/');
                }
            }
        });

        // Same rewrite for WebSocket upgrade requests
        this.proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
            const targetOrigin = `http://127.0.0.1:${this.targetPort}`;
            proxyReq.removeHeader('x-forwarded-host');
            proxyReq.removeHeader('x-forwarded-for');
            proxyReq.removeHeader('x-forwarded-proto');
            proxyReq.removeHeader('forwarded');
            proxyReq.setHeader('origin', targetOrigin);
        });

        this.proxy.on('error', (err, req, res) => {
            console.error('[ARC] Error de proxy:', err.message);
            if (res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('El servidor de lenguaje Antigravity no está disponible temporalmente. Asegúrate de que el IDE local esté activo.');
            }
        });

        // Inject Session Middleware / Secure Authentication
        app.use((req, res, next) => {
            // Bypass asset check or dashboard script
            if (req.path === '/arc-dashboard.js') {
                return next();
            }

            // Bypass static assets to ensure the app shell always loads under public HTTPS tunnels
            const isStaticAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|otf)$/i.test(req.path);
            if (isStaticAsset) {
                return next();
            }

            const tokenQuery = req.query.token;
            const tokenHeader = req.headers['x-arc-token'];
            
            // Build dynamic cookie options based on HTTPS/localtunnel protocol
            const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
            const cookieOptions = {
                httpOnly: true,
                maxAge: 7 * 24 * 60 * 60 * 1000 // 1 week
            };
            if (isSecure) {
                cookieOptions.secure = true;
                cookieOptions.sameSite = 'none';
            }

            // Check auth token
            if (tokenQuery === this.sessionToken || tokenHeader === this.sessionToken) {
                // Set cookie
                res.cookie('arc_session_token', this.sessionToken, cookieOptions);
                return next();
            }

            // Check cookie
            const cookies = this.parseCookies(req.headers.cookie);
            if (cookies['arc_session_token'] === this.sessionToken) {
                return next();
            }

            // Render Premium Glassmorphic Portal
            if (req.method === 'POST' && req.body.token === this.sessionToken) {
                res.cookie('arc_session_token', this.sessionToken, cookieOptions);
                return res.redirect(req.path);
            }

            this.renderLoginPortal(req, res);
        });

        // Route for dashboard javascript
        app.get('/arc-dashboard.js', (req, res) => {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.sendFile(path.join(__dirname, 'dashboard.js'));
        });

        // Route for premium logo image and favicon
        app.get('/logo.png', (req, res) => {
            res.sendFile(path.join(__dirname, 'logo.png'));
        });
        app.get('/logo.ico', (req, res) => {
            res.sendFile(path.join(__dirname, 'logo.ico'));
        });
        app.get('/favicon.ico', (req, res) => {
            res.sendFile(path.join(__dirname, 'logo.ico'));
        });

        // Intercept root index.html to inject our dashboard script
        app.get('/', async (req, res) => {
            this.handleIndexRequest(req, res);
        });
        app.get('/index.html', async (req, res) => {
            this.handleIndexRequest(req, res);
        });

        // Catch-all route to proxy HTTP requests
        app.all('*', (req, res) => {
            console.log(`[ARC Proxy] Forwarding request: ${req.method} ${req.path}`);
            this.proxy.web(req, res);
        });

        // Create Native Server to handle upgrade
        this.server = http.createServer(app);

        // Setup local WebSocket channel for dashboard control / notification simulation
        this.wsServer = new ws.Server({ noServer: true });
        this.wsServer.on('connection', (socket) => {
            this.clients.add(socket);
            console.log('\x1b[90m[ARC] Cliente conectado al WebSocket de control remoto.\x1b[0m');
            
            // Trigger welcome toast
            socket.send(JSON.stringify({
                type: 'toast',
                message: '¡Control remoto emparejado con éxito! Sistema activo.'
            }));

            socket.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    console.log(`[ARC] Acción recibida: ${data.type}`, data.payload);
                    
                    if (data.type === 'pause') {
                        // Forward or manage pause state
                        console.log(`\x1b[90m[ARC] Pausa de sesión remota cambiada a: ${data.payload.value}\x1b[0m`);
                    } else if (data.type === 'disconnect') {
                        console.log('[ARC] Desconexión solicitada por el cliente. Apagando servidor...');
                        this.shutdown();
                    }
                } catch (err) {
                    console.error('[ARC] Error al procesar mensaje de WebSocket:', err);
                }
            });

            socket.on('close', () => {
                this.clients.delete(socket);
                console.log('\x1b[90m[ARC] WebSocket de control remoto desconectado.\x1b[0m');
            });
        });

        this.server.on('upgrade', (req, socket, head) => {
            const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            if (parsedUrl.pathname === '/arc-control-ws') {
                this.wsServer.handleUpgrade(req, socket, head, (wsConn) => {
                    this.wsServer.emit('connection', wsConn, req);
                });
            } else {
                // Pass target CSRF in headers if necessary or let proxy pass
                this.proxy.ws(req, socket, head, (err) => {
                    console.error('[ARC] WebSocket Proxy upgrade error:', err.message);
                });
            }
        });

        // Start listening
        return new Promise((resolve, reject) => {
            this.server.listen(this.port, '0.0.0.0', async (err) => {
                if (err) {
                    return reject(err);
                }
                console.log(`\x1b[90m[ARC] Pasarela local activa en http://localhost:${this.port}\x1b[0m`);
                
                // Expose public tunnel if specified
                let publicUrl = null;
                if (this.usePublic) {
                    console.log('\x1b[90m[ARC] Inicializando túnel público seguro via localtunnel...\x1b[0m');
                    try {
                        const localtunnel = require('localtunnel');
                        const tunnel = await localtunnel({ port: this.port });
                        
                        tunnel.on('close', () => {
                            console.log('\x1b[90m[ARC] Túnel público cerrado.\x1b[0m');
                        });
                        
                        publicUrl = `${tunnel.url}/?token=${this.sessionToken}`;
                        console.log(`\x1b[90m[ARC] Túnel público establecido: ${tunnel.url}\x1b[0m`);
                    } catch (tunnelErr) {
                        console.error('[ARC] Error al crear el túnel público:', tunnelErr.message);
                    }
                }

                resolve({
                    localUrl: `http://localhost:${this.port}/?token=${this.sessionToken}`,
                    publicUrl
                });
            });
        });
    }

    async setupTarget() {
        // Option 1: Discover from process env of active agent session
        if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
            const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
            const parts = addr.split(':');
            this.targetPort = parseInt(parts[parts.length - 1], 10);
            this.targetCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
            console.log(`\x1b[90m[ARC] Servidor de lenguaje Antigravity detectado en el puerto ${this.targetPort}\x1b[0m`);
            return;
        }

        // Option 1.5: Discover running IDE process in Windows
        if (process.platform === 'win32') {
            console.log('\x1b[90m[ARC] Buscando una instancia activa de Antigravity IDE en ejecución...\x1b[0m');
            try {
                const processInfoStr = await new Promise((resolve) => {
                    const cmd = `powershell -Command "Get-CimInstance Win32_Process -Filter 'Name = ''language_server.exe''' | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
                    exec(cmd, (err, stdout) => {
                        if (err) resolve(null);
                        else resolve(stdout ? stdout.trim() : null);
                    });
                });

                if (processInfoStr) {
                    let processes = [];
                    try {
                        const parsed = JSON.parse(processInfoStr);
                        processes = Array.isArray(parsed) ? parsed : [parsed];
                    } catch (e) {
                        // ignore parse errors
                    }

                    for (const proc of processes) {
                        if (!proc.CommandLine || !proc.ProcessId) continue;
                        
                        // Extract csrf token from command line
                        const csrfMatch = /--csrf_token\s+([^\s]+)/.exec(proc.CommandLine);
                        if (!csrfMatch) continue;
                        const csrfToken = csrfMatch[1];

                        // Find listening ports for this ProcessId
                        const portsStr = await new Promise((resolve) => {
                            const cmd = `powershell -Command "Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -eq ${proc.ProcessId} } | Select-Object LocalPort | ConvertTo-Json"`;
                            exec(cmd, (err, stdout) => {
                                if (err) resolve(null);
                                else resolve(stdout ? stdout.trim() : null);
                            });
                        });

                        if (portsStr) {
                            let portsObj = [];
                            try {
                                const parsed = JSON.parse(portsStr);
                                portsObj = Array.isArray(parsed) ? parsed : [parsed];
                            } catch (e) {}

                            const ports = portsObj.map(p => p.LocalPort).filter(Boolean);
                            
                            // Probe each port to find the HTTP server returning 200
                            for (const port of ports) {
                                const isHttp = await new Promise((resolve) => {
                                    const httpLib = require('http');
                                    const req = httpLib.get(`http://127.0.0.1:${port}/`, (res) => {
                                        // A valid HTTP response means it is the HTTP listener
                                        resolve(res.statusCode === 200 || res.statusCode === 401 || res.statusCode === 403);
                                    });
                                    req.on('error', () => resolve(false));
                                    req.setTimeout(1000, () => {
                                        req.destroy();
                                        resolve(false);
                                    });
                                });

                                if (isHttp) {
                                    this.targetPort = port;
                                    this.targetCsrf = csrfToken;
                                    console.log(`\x1b[92m[ARC] ¡Conectado dinámicamente al IDE activo (PID: ${proc.ProcessId}) en el puerto ${this.targetPort}!\x1b[0m`);
                                    return;
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.log(`\x1b[93m[ARC] Advertencia durante la detección automática: ${err.message}\x1b[0m`);
            }
        }

        // Option 2: Fallback to check standard AppData or run active command status, or spawn new headless session
        console.log('\x1b[90m[ARC] No se encontró una instancia local activa en ejecución. Iniciando una headless...\x1b[0m');
        console.log('\x1b[90m[ARC] Iniciando una nueva instancia headless de Antigravity Language Server...\x1b[0m');
        
        if (!fs.existsSync(LS_BINARY)) {
            throw new Error(`Antigravity binary not found at ${LS_BINARY}. Please verify install.`);
        }

        this.targetCsrf = require('crypto').randomUUID();
        const args = [
            '--standalone',
            '--override_ide_name', 'antigravity',
            '--subclient_type', 'cli',
            '--override_ide_version', '2.0.1',
            '--override_user_agent_name', 'antigravity-remote',
            '--http_server_port', '0',
            '--csrf_token', this.targetCsrf,
            '--app_data_dir', 'antigravity-ide',
            '--api_server_url', 'https://generativelanguage.googleapis.com',
            '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
            '--enable_sidecars',
            '--headless'
        ];

        console.log(`[ARC] Launching: ${LS_BINARY} ${args.join(' ')}`);
        
        const env = { ...process.env };
        this.lsProcess = spawn(LS_BINARY, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.lsProcess.stdin.end();

        return new Promise((resolve, reject) => {
            const rl = require('readline').createInterface({ input: this.lsProcess.stdout });
            const errorTimeout = setTimeout(() => {
                reject(new Error('Language Server startup timed out waiting for port allocation.'));
            }, 30000);

            rl.on('line', (line) => {
                // Regex matches "listening on http port at (\d+) for HTTP"
                const match = /listening on \w+ port at (\d+) for HTTP/i.exec(line);
                if (match) {
                    clearTimeout(errorTimeout);
                    this.targetPort = parseInt(match[1], 10);
                    console.log(`\x1b[90m[ARC] Servidor de lenguaje Antigravity (Headless) iniciado en el puerto ${this.targetPort}\x1b[0m`);
                    
                    // Hook standard events to forward push notifications or logs
                    this.monitorLogs();

                    resolve();
                }
            });

            this.lsProcess.on('exit', (code) => {
                clearTimeout(errorTimeout);
                if (!this.targetPort) {
                    reject(new Error(`Language Server exited prematurely with code ${code}`));
                }
            });
        });
    }

    monitorLogs() {
        const errorRl = require('readline').createInterface({ input: this.lsProcess.stderr });
        errorRl.on('line', (line) => {
            if (line.includes('error') || line.includes('panic') || line.includes('fatal')) {
                console.error(`[LS-Stderr] ${line}`);
            }
        });
    }

    async handleIndexRequest(req, res) {
        // Intercept root page to inject the custom ARC header script
        const targetUrl = `http://127.0.0.1:${this.targetPort}/`;
        
        const httpLib = require('http');
        httpLib.get(targetUrl, (targetRes) => {
            let body = '';
            targetRes.on('data', chunk => body += chunk);
            targetRes.on('end', () => {
                // Inject the native mock bridge scripts in the head to prevent browser startup crashes
                const mockBridges = `
<title>Antigravity Remote</title>
<meta name="description" content="Antigravity Remote Control — controlá tu agente de IA desde cualquier dispositivo." />
<meta name="application-name" content="Antigravity Remote" />
<meta name="theme-color" content="#161617" />
<link rel="apple-touch-icon" href="/logo.png" />
<link rel="icon" type="image/png" href="/logo.png" />
<meta property="og:title" content="Antigravity Remote" />
<meta property="og:description" content="Controlá tu agente Antigravity desde cualquier dispositivo." />
<meta property="og:type" content="website" />
<meta property="og:image" content="/logo.png" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="Antigravity Remote" />
<meta name="twitter:description" content="Controlá tu agente Antigravity desde cualquier dispositivo." />
<meta name="twitter:image" content="/logo.png" />
<script>
window.nativeStorage = {
    getItems: async () => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            items[key] = localStorage.getItem(key);
        }
        return items;
    },
    updateItems: async (changes) => {
        for (const [key, val] of Object.entries(changes)) {
            if (val === null) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, val);
            }
        }
        if (window.nativeStorage._onChangedCallback) {
            window.nativeStorage._onChangedCallback(changes);
        }
    },
    onChanged: (callback) => {
        window.nativeStorage._onChangedCallback = callback;
        return () => {
            window.nativeStorage._onChangedCallback = null;
        };
    }
};

window.nativeNotifications = {
    onClicked: (callback) => {},
    send: (notification) => {
        console.log('[ARC Mock] Native notification:', notification);
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(notification.title || 'Antigravity', {
                body: notification.body || notification.message || ''
            });
        }
    },
    openSystemPreferences: () => {}
};

window.electronUpdater = {
    onStateChanged: () => {},
    applyUpdate: async () => {},
    quitAndInstall: async () => {}
};

window.electronNative = {
    getZoomLevel: () => 1,
    minimize: () => {},
    maximize: () => {},
    unmaximize: () => {},
    isMaximized: () => false,
    close: () => {},
    toggleDevTools: () => {},
    zoomIn: () => {},
    zoomOut: () => {},
    resetZoom: () => {},
    openExternal: (url) => window.open(url, '_blank'),
    setTitleBarOverlay: () => {},
    appVersion: "2.0.1"
};
</script>
`;
                let modifiedBody = body.replace(/<title>Antigravity<\/title>/i, mockBridges);
                modifiedBody = modifiedBody.replace(/<link\s+[\s\S]*?rel="icon"[\s\S]*?\/>/gi, `<link rel="icon" type="image/x-icon" href="/logo.ico" />`);
                
                // Inject the dashboard JS bundle right before </body>
                const injectedScript = `<script src="/arc-dashboard.js"></script></body>`;
                modifiedBody = modifiedBody.replace('</body>', injectedScript);
                
                // Set original app config to bypass csrf issues
                modifiedBody = modifiedBody.replace(
                    /window\.__APP_CONFIG__\s*=\s*({[^}]+})/i,
                    (match, group) => {
                        try {
                            const config = JSON.parse(group);
                            config.csrfToken = this.targetCsrf;
                            return `window.__APP_CONFIG__ = ${JSON.stringify(config)}`;
                        } catch (err) {
                            return match;
                        }
                    }
                );

                res.writeHead(targetRes.statusCode, {
                    ...targetRes.headers,
                    'content-length': Buffer.byteLength(modifiedBody),
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': 'no-cache, no-store, must-revalidate'
                });
                res.end(modifiedBody);
            });
        }).on('error', (err) => {
            console.error('[ARC] Error fetching index:', err);
            res.status(500).send('Error connecting to local server.');
        });
    }

    parseCookies(cookieStr) {
        const list = {};
        if (cookieStr) {
            cookieStr.split(';').forEach((cookie) => {
                const parts = cookie.split('=');
                list[parts.shift().trim()] = decodeURI(parts.join('='));
            });
        }
        return list;
    }

    renderLoginPortal(req, res) {
        const loginHtml = `
        <!doctype html>
        <html lang="es">
        <head>
            <meta charset="utf-8">
            <title>Portal de Acceso Antigravity</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    height: 100vh;
                    background: #161617;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
                    color: #f5f5f7;
                    overflow: hidden;
                    position: relative;
                }

                .card {
                    background: rgba(30, 30, 32, 0.65);
                    backdrop-filter: saturate(180%) blur(30px);
                    -webkit-backdrop-filter: saturate(180%) blur(30px);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 12px;
                    padding: 40px 32px;
                    width: 100%;
                    box-sizing: border-box;
                    max-width: 360px;
                    text-align: center;
                    z-index: 10;
                    position: relative;
                    animation: slideUp 0.6s cubic-bezier(0.25, 1, 0.5, 1);
                }

                @keyframes slideUp {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }

                .logo {
                    font-weight: 300;
                    font-size: 22px;
                    color: #f5f5f7;
                    letter-spacing: -0.02em;
                    text-transform: lowercase;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-bottom: 8px;
                    -webkit-font-smoothing: antialiased;
                }

                .logo-sub {
                    font-weight: 500;
                    color: #86868b;
                    font-size: 11px;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    background: rgba(255, 255, 255, 0.06);
                    border: 1px solid rgba(255, 255, 255, 0.06);
                    padding: 1px 5px;
                    border-radius: 4px;
                    margin-left: 6px;
                }

                .subtitle {
                    font-size: 13px;
                    line-height: 1.5;
                    color: #86868b;
                    margin-bottom: 30px;
                    -webkit-font-smoothing: antialiased;
                }

                .input-group {
                    position: relative;
                    margin-bottom: 20px;
                }

                input[type="password"] {
                    width: 100%;
                    box-sizing: border-box;
                    padding: 12px 14px;
                    background: rgba(255, 255, 255, 0.02);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 6px;
                    color: #fff;
                    font-size: 14px;
                    transition: all 0.2s cubic-bezier(0.25, 1, 0.5, 1);
                    outline: none;
                    text-align: center;
                    letter-spacing: 2px;
                    font-family: inherit;
                }

                input[type="password"]::placeholder {
                    letter-spacing: 0px;
                    color: #86868b;
                }

                input[type="password"]:focus {
                    background: rgba(255, 255, 255, 0.04);
                    border-color: rgba(255, 255, 255, 0.2);
                }

                button {
                    width: 100%;
                    padding: 12px;
                    background: #f5f5f7;
                    border: none;
                    border-radius: 6px;
                    color: #161617;
                    font-weight: 500;
                    font-size: 14px;
                    cursor: pointer;
                    transition: all 0.2s cubic-bezier(0.25, 1, 0.5, 1);
                    font-family: inherit;
                    -webkit-font-smoothing: antialiased;
                }

                button:hover {
                    background: #ffffff;
                }

                button:active {
                    background: #e8e8ed;
                    transform: scale(0.99);
                }

                .footer {
                    margin-top: 30px;
                    font-size: 9px;
                    color: rgba(255, 255, 255, 0.25);
                    letter-spacing: 0.1em;
                    text-transform: uppercase;
                    font-weight: 500;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="logo">
                    antigravity <span class="logo-sub">arc</span>
                </div>
                <div class="subtitle">Ingresa el token de conexión para desbloquear el control remoto.</div>
                <form method="POST">
                    <div class="input-group">
                        <input type="password" name="token" required placeholder="token de conexión" autocomplete="off" autofocus />
                    </div>
                    <button type="submit">Conectar Control</button>
                </form>
                <div class="footer">GOOGLE ANTIGRAVITY SDK</div>
            </div>
        </body>
        </html>
        `;
        res.setHeader('Content-Type', 'text/html');
        res.status(401).send(loginHtml);
    }

    shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        console.log('[ARC] Apagando el servidor proxy de control remoto...');
        
        // Notify clients
        for (const client of this.clients) {
            client.send(JSON.stringify({ type: 'toast', message: 'El servidor se está apagando.' }));
            client.close();
        }

        if (this.server) {
            this.server.close();
        }

        // Spawn kill on LS if we spawned it
        if (this.lsProcess) {
            console.log('[ARC] Finalizando el servidor de lenguaje headless...');
            this.lsProcess.kill('SIGTERM');
        }

        process.exit(0);
    }
}

module.exports = { ArcServer };
