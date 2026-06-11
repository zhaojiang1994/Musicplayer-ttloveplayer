// ==================== Electron 主进程 ====================
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 880,
        height: 680,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        title: '千千静听 · 南岭典藏',
        autoHideMenuBar: true,
        center: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // 等页面加载完再显示避免白屏闪烁
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.loadFile('mc.html');
    // mainWindow.webContents.openDevTools(); // 调试用
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ==================== 文件系统扫描（IPC） ====================

/** 扫描本地目录，返回 { folders: [], files: [] } */
function scanLocalDirectory(dirPath) {
    const result = { folders: [], files: [] };
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                result.folders.push(entry.name);
            } else if (entry.isFile() && /\.(mp3|wav|flac|m4a|ogg)$/i.test(entry.name)) {
                result.files.push({
                    name: entry.name,
                    path: fullPath,
                    url: 'file://' + fullPath.replace(/\\/g, '/')
                });
            }
        }
    } catch (e) {
        return { error: e.message };
    }
    return result;
}

/** 递归扫描本地目录树（最大深度3层） */
function scanLocalDirectoryDeep(rootPath, maxDepth) {
    maxDepth = maxDepth || 2;
    const songs = [];
    const idPrefix = 'local_' + rootPath.replace(/[^a-zA-Z0-9]/g, '_');

    function walk(dir, depth) {
        if (depth > maxDepth) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                } else if (entry.isFile() && /\.(mp3|wav|flac|m4a|ogg)$/i.test(entry.name)) {
                    const folderName = path.basename(dir);
                    const parsed = parseSongFile(entry.name);
                    songs.push({
                        id: idPrefix + '_' + songs.length,
                        name: parsed.song || entry.name.replace(/\.[^/.]+$/, ''),
                        artist: parsed.artist || extractArtistFromFolder(folderName) || '未知歌手',
                        src: 'file://' + fullPath.replace(/\\/g, '/'),
                        folder: folderName,
                        source: rootPath,
                        sourceName: path.basename(rootPath) || rootPath,
                        isDefault: false,
                        duration: '--:--'
                    });
                }
            }
        } catch (e) {}
    }

    walk(rootPath, 0);
    return songs;
}

/** 通过 fetch 扫描 HTTP 目录（保留原有逻辑） */
function scanHttpDirectory(urlStr) {
    return new Promise((resolve) => {
        const url = new URL(urlStr);
        const mod = url.protocol === 'https:' ? https : http;
        mod.get(urlStr, (res) => {
            let html = '';
            res.on('data', (chunk) => { html += chunk; });
            res.on('end', () => {
                resolve(parseHtmlDirectory(html, urlStr));
            });
        }).on('error', (err) => {
            resolve({ error: err.message });
        });
    });
}

/** 解析 HTML 目录列表（nginx/Apache 格式） */
function parseHtmlDirectory(html, baseUrl) {
    const result = { folders: [], files: [] };
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const linkRegex = /<a\s[^>]*href="([^"]*)"[^>]*>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
        let href = match[1];
        if (!href || href === '../' || href === '/') continue;
        href = decodeURIComponent(href);

        if (href.endsWith('/')) {
            result.folders.push(href.slice(0, -1));
        } else if (/\.(mp3|wav|flac|m4a|ogg)$/i.test(href)) {
            result.files.push({
                name: decodeURIComponent(href),
                path: href,
                url: base + href
            });
        }
    }
    return result;
}

/** 通用歌曲文件名解析 */
function parseSongFile(filename) {
    let name = filename.replace(/\.(mp3|wav|flac|m4a|ogg)$/i, '');
    if (name.includes(' - ')) {
        const parts = name.split(' - ');
        let song = parts[0].trim();
        let artist = parts[1].trim();
        if (artist.length < 2 || /^\d+$/.test(artist)) {
            return { artist: null, song: name };
        }
        return { artist, song };
    }
    return { artist: null, song: name };
}

function extractArtistFromFolder(folderName) {
    if (!folderName) return '未知歌手';
    let cleaned = folderName.replace(/专辑|全集|无损|flac|mp3|CD\d?|Disc\d?|部分|合集|精选|经典|歌曲|音乐|大全|收藏/g, '');
    cleaned = cleaned.replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '');
    cleaned = cleaned.trim();
    return cleaned || folderName;
}

// ==================== IPC 处理 ====================

/** 扫描单个来源 */
ipcMain.handle('scan-source', async (event, sourceUrl, sourceName) => {
    const url = sourceUrl.trim();

    // 本地路径（Windows: D:\... 或 Unix: /...）
    if (/^[a-zA-Z]:\\/.test(url) || url.startsWith('/')) {
        const songs = scanLocalDirectoryDeep(url, 2);
        return { songs, type: 'local' };
    }

    // SMB 路径（需要先映射或通过 HTTP 代理）
    if (url.startsWith('\\\\')) {
        // 尝试作为本地 UNC 路径读取
        const songs = scanLocalDirectoryDeep(url, 2);
        if (songs.length > 0) return { songs, type: 'smb' };
        return { songs: [], error: 'SMB 路径无法访问，请先映射为网络驱动器或使用 HTTP 服务中转', type: 'smb' };
    }

    // HTTP/HTTPS（走原有逻辑）
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return { songs: await scanHttpDeep(url), type: 'http' };
    }

    return { songs: [], error: '不支持的地址格式: ' + url, type: 'unknown' };
});

/** 递归扫描 HTTP 目录 */
async function scanHttpDeep(rootUrl) {
    const songs = [];
    const idPrefix = 'http_' + rootUrl.replace(/[^a-zA-Z0-9]/g, '_');
    const baseUrl = rootUrl.endsWith('/') ? rootUrl : rootUrl + '/';
    const visited = new Set();

    async function walk(dirUrl, depth) {
        if (depth > 2 || visited.has(dirUrl)) return;
        visited.add(dirUrl);
        const result = await scanHttpDirectory(dirUrl);
        if (result.error) return;

        for (const folder of result.folders) {
            const folderUrl = dirUrl + encodeURIComponent(folder) + '/';
            const subResult = await scanHttpDirectory(folderUrl);
            if (subResult.error) continue;
            for (const file of subResult.files) {
                const parsed = parseSongFile(file.name);
                songs.push({
                    id: idPrefix + '_' + songs.length,
                    name: parsed.song || file.name.replace(/\.[^/.]+$/, '').substring(0, 30),
                    artist: parsed.artist || extractArtistFromFolder(folder) || '未知歌手',
                    src: file.url,
                    folder: folder,
                    source: rootUrl,
                    sourceName: sourceNameCache[rootUrl] || rootUrl.replace(/^https?:\/\//, '').split('/')[0],
                    isDefault: false,
                    duration: '--:--'
                });
            }
        }
    }

    await walk(baseUrl, 0);
    return songs;
}

const sourceNameCache = {};

ipcMain.handle('cache-source-name', (event, url, name) => {
    sourceNameCache[url] = name;
});

/** 打开文件夹选择对话框 */
ipcMain.handle('select-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

/** 窗口控制 */
ipcMain.on('window-minimize', () => { mainWindow.minimize(); });
ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.on('window-close', () => { mainWindow.close(); });
