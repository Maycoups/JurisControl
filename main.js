const { app, BrowserWindow, Menu, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// --- Armazenamento seguro de credenciais (chave da API Anthropic, etc.) ---
// Usa safeStorage (criptografia do SO — DPAPI no Windows, Keychain no macOS) e grava
// num arquivo FORA da pasta do projeto (em userData), então nunca vai parar em
// commit/git/backup do código-fonte. O renderer nunca vê o arquivo em disco, só fala
// com esse armazenamento via IPC (ver preload.js).
const secretsFilePath = () => path.join(app.getPath('userData'), 'jc-secrets.enc.json');

function lerSecretsArquivo() {
    try {
        const raw = fs.readFileSync(secretsFilePath(), 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function gravarSecretsArquivo(mapa) {
    fs.mkdirSync(path.dirname(secretsFilePath()), { recursive: true });
    fs.writeFileSync(secretsFilePath(), JSON.stringify(mapa), { mode: 0o600 });
}

function registrarHandlersSecrets() {
    ipcMain.handle('jc-secrets:disponivel', () => safeStorage.isEncryptionAvailable());

    ipcMain.handle('jc-secrets:set', (_evt, nome, valor) => {
        try {
            if (!safeStorage.isEncryptionAvailable()) {
                return { ok: false, erro: 'Criptografia do sistema operacional indisponível nesta máquina.' };
            }
            const mapa = lerSecretsArquivo();
            mapa[nome] = safeStorage.encryptString(String(valor)).toString('base64');
            gravarSecretsArquivo(mapa);
            return { ok: true };
        } catch (e) {
            return { ok: false, erro: e.message };
        }
    });

    ipcMain.handle('jc-secrets:get', (_evt, nome) => {
        try {
            const mapa = lerSecretsArquivo();
            if (!mapa[nome]) return null;
            if (!safeStorage.isEncryptionAvailable()) return null;
            return safeStorage.decryptString(Buffer.from(mapa[nome], 'base64'));
        } catch {
            return null;
        }
    });

    ipcMain.handle('jc-secrets:delete', (_evt, nome) => {
        try {
            const mapa = lerSecretsArquivo();
            delete mapa[nome];
            gravarSecretsArquivo(mapa);
            return { ok: true };
        } catch (e) {
            return { ok: false, erro: e.message };
        }
    });

    ipcMain.handle('jc-secrets:list', () => {
        try {
            return Object.keys(lerSecretsArquivo());
        } catch {
            return [];
        }
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: "JurisControl - Gestão Jurídica",
        autoHideMenuBar: true, // Esconde a barra de menus superior
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            devTools: true,
            preload: path.join(__dirname, 'preload.js'),
        }
    });

    // Remove a barra de menus padrão do Windows
    Menu.setApplicationMenu(null);

    // Carrega o seu arquivo HTML
    win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
    registrarHandlersSecrets();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
