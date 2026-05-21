#!/usr/bin/env node

const { ArcServer } = require('./server');
const crypto = require('crypto');
const ip = require('ip');
const qrcode = require('qrcode-terminal');

// Basic CLI Argument Parsing
const args = process.argv.slice(2);
const options = {
    port: 9090,
    public: false,
    token: null
};

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
        options.port = parseInt(args[++i], 10);
    } else if (args[i] === '--public') {
        options.public = true;
    } else if (args[i] === '--token' || args[i] === '-t') {
        options.token = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
        printHelp();
        process.exit(0);
    }
}

function printHelp() {
    console.log(`
🌌 Antigravity Remote Control (ARC) CLI
Usage: node cli.js [options]

Options:
  -p, --port <number>   Port to listen on (default: 9090)
  --public              Enable secure public tunnel (localtunnel)
  -t, --token <string>  Specify a custom high-entropy connection token
  -h, --help            Show this help menu
`);
}

// Generate connection token if not provided
if (!options.token) {
    options.token = crypto.randomBytes(6).toString('hex'); // 12-char high-entropy token
}

const localIp = ip.address();
const server = new ArcServer(options);

const colors = ['\x1b[95m', '\x1b[94m', '\x1b[96m', '\x1b[92m', '\x1b[93m', '\x1b[91m']; // purple, blue, cyan, green, yellow, red

function getMulticolorSeparator(length = 70) {
    let result = '';
    for (let i = 0; i < length; i++) {
        const color = colors[Math.floor(i / 6) % colors.length];
        result += `${color}═`;
    }
    return result + '\x1b[0m';
}

function getMulticolorTitle(text) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const color = colors[i % colors.length];
        result += `${color}${text[i]}`;
    }
    return result + '\x1b[0m';
}

console.clear();
console.log(getMulticolorSeparator(70));
console.log(getMulticolorTitle('     🚀   A N T I G R A V I T Y   |   C O N T R O L   R E M O T E   🚀     '));
console.log(getMulticolorSeparator(70));
console.log(`\n🔑 \x1b[1mToken de Seguridad:\x1b[0m \x1b[93m${options.token}\x1b[0m`);
console.log(`📡 \x1b[1mEnlace Wi-Fi Local:\x1b[0m  \x1b[36mhttp://${localIp}:${options.port}/?token=${options.token}\x1b[0m`);
console.log(`💻 \x1b[1mAcceso Localhost:\x1b[0m    \x1b[34mhttp://localhost:${options.port}/?token=${options.token}\x1b[0m\n`);

server.start().then((results) => {
    const localIpUrl = `http://${localIp}:${options.port}/?token=${options.token}`;
    
    console.log('\n' + getMulticolorSeparator(70));
    if (results.publicUrl) {
        console.log(`⚡ \x1b[92m\x1b[1mRUTA PÚBLICA ACTIVA:\x1b[0m`);
        console.log(`   \x1b[95m${results.publicUrl}\x1b[0m`);
    } else {
        console.log(`ℹ️  \x1b[93mRed Local Activa. Conéctate desde tu móvil en la misma red Wi-Fi.\x1b[0m`);
    }
    console.log(getMulticolorSeparator(70));

    console.log('\n📱 \x1b[1mESCANEA ESTE CÓDIGO QR CON TU MÓVIL PARA CONECTARTE:\x1b[0m');
    
    // Generate ASCII/ANSI QR Code pointing strictly to local IP
    qrcode.generate(localIpUrl, { small: true }, (code) => {
        console.log(code);
    });

    console.log('\x1b[90mPresiona Ctrl+C para finalizar la sesión del control remoto.\x1b[0m');
}).catch((err) => {
    console.error('\n\x1b[31m%s\x1b[0m', `❌ Error al iniciar el servidor: ${err.message}`);
    process.exit(1);
});

// Setup graceful termination
process.on('SIGINT', () => {
    console.log('\n[ARC] Caught interrupt signal. Initiating graceful teardown...');
    server.shutdown();
});
