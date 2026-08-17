// preload.js — ponte segura entre o processo principal (Node/Electron) e a página
// (renderer, sem acesso direto ao Node porque nodeIntegration:false/contextIsolation:true).
//
// Expõe window.jcSecrets no front-end para guardar credenciais (ex: chave da API
// Anthropic) SEM colocá-las no código-fonte e SEM enviá-las pra lugar nenhum além
// do que o próprio usuário decide (ex: corpo de uma chamada à Edge Function).
//
// As credenciais são criptografadas com safeStorage (usa o cofre do Windows/macOS/
// Linux — no Windows, DPAPI, atrelado à conta do usuário logado) e gravadas num
// arquivo fora da pasta do projeto (em app.getPath('userData')), então nunca vão
// parar num commit/git/backup do código.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jcSecrets', {
    // Salva (ou sobrescreve) uma credencial. Retorna { ok: true } ou { ok: false, erro }.
    set: (nome, valor) => ipcRenderer.invoke('jc-secrets:set', nome, valor),
    // Lê uma credencial já salva. Retorna string (o valor) ou null se não existir/falhar.
    get: (nome) => ipcRenderer.invoke('jc-secrets:get', nome),
    // Remove uma credencial salva.
    delete: (nome) => ipcRenderer.invoke('jc-secrets:delete', nome),
    // Lista os NOMES das credenciais salvas (nunca os valores) — útil pra UI mostrar
    // "configurada" / "não configurada" sem decriptar nada à toa.
    list: () => ipcRenderer.invoke('jc-secrets:list'),
    // Informa se o cofre do sistema operacional está disponível nesta máquina.
    disponivel: () => ipcRenderer.invoke('jc-secrets:disponivel'),
});
