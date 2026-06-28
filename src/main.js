import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWebDav, stopWebDav } from './webdav.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARE_PORT = 8787;
const WEBDAV_PORT = 8788;
let shareServer = null;
let webDavState = null;
let shareState = {
  running: false,
  folders: [],
  port: SHARE_PORT,
  urls: [],
  error: ''
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

async function readConfig() {
  try {
    const raw = await readFile(configPath(), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig({});
  }
}

function normalizeConfig(config) {
  const sharedFolders = Array.isArray(config.sharedFolders)
    ? config.sharedFolders
    : config.sharedFolder
      ? [config.sharedFolder]
      : [];

  return {
    ...config,
    sharedFolders: [...new Set(sharedFolders.filter(Boolean).map(folder => path.resolve(folder)))],
    hostName: os.hostname() || app.getName(),
    sharePasswordEncrypted: config.sharePasswordEncrypted || ''
  };
}

function decryptSharePassword(config) {
  if (!config.sharePasswordEncrypted || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(config.sharePasswordEncrypted, 'base64'));
  } catch {
    return '';
  }
}

async function saveConfig(config) {
  const nextConfig = normalizeConfig(config);
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(configPath(), JSON.stringify(nextConfig, null, 2));
  if (nextConfig.sharedFolders.length > 0) {
    await startShareServer(nextConfig.sharedFolders, nextConfig);
  } else {
    await stopShareServer();
  }
  return nextConfig;
}

function getLanAddresses(port) {
  const addresses = [];

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return addresses;
}

function getLanHosts() {
  const hosts = new Set();

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;

      const parts = entry.address.split('.');
      if (parts.length !== 4) continue;

      const prefix = parts.slice(0, 3).join('.');
      const ownAddress = entry.address;
      for (let index = 1; index < 255; index += 1) {
        const address = `${prefix}.${index}`;
        if (address !== ownAddress) hosts.add(address);
      }
    }
  }

  return [...hosts];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char];
  });
}

function toHref(relativePath, isDirectory = false) {
  const parts = relativePath.split(path.sep).filter(Boolean).map(encodeURIComponent);
  return `/${parts.join('/')}${isDirectory ? '/' : ''}`;
}

function toSafePath(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  const rootWithSeparator = `${path.resolve(root)}${path.sep}`;

  if (target !== path.resolve(root) && !target.startsWith(rootWithSeparator)) {
    return null;
  }

  return target;
}

function htmlPage(title, body) {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body{margin:0;padding:28px;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101114;color:#f2efe8}',
    'main{max-width:960px;margin:0 auto}',
    'h1{font-size:22px;margin:0}',
    'a{color:#ffd28a;text-decoration:none}',
    'a:hover{text-decoration:underline}',
    'ul{list-style:none;margin:0;padding:0;border:1px solid #2d313b;border-radius:8px;overflow:hidden}',
    'li{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #2d313b}',
    'li:last-child{border-bottom:0}',
    '.page-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}',
    '.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 14px}',
    'button,.upload{border:1px solid #3a3f49;border-radius:7px;padding:7px 11px;background:#20232a;color:#f2efe8;cursor:pointer;font:inherit}',
    'button:hover,.upload:hover{border-color:#ffd28a}',
    '.upload input{display:none}',
    '.entry{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.actions{display:flex;gap:6px}',
    '.actions button{padding:4px 8px;color:#b8bec8;background:transparent}',
    '.actions .danger{color:#ff9b92}',
    '.status{min-height:20px;margin:10px 0;color:#ffd28a}',
    '.muted{color:#9da4af}',
    '</style>',
    '</head>',
    `<body><main>${body}</main></body>`,
    '</html>'
  ].join('');
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function managedPath(root, relativePath, options = {}) {
  const target = toSafePath(root, relativePath || '/');
  if (!target) throw new Error('禁止访问共享目录之外的路径');

  const realRoot = await realpath(root);
  const parent = target === path.resolve(root) ? target : path.dirname(target);
  const realParent = await realpath(parent);
  if (!isPathInside(realRoot, realParent)) throw new Error('禁止通过链接访问共享目录之外的路径');

  if (options.mustExist) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('不允许操作符号链接');
  }

  return target;
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('请求内容过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('请求格式无效'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function validEntryName(value) {
  const name = String(value || '').trim();
  return name && name !== '.' && name !== '..' && path.basename(name) === name ? name : '';
}

async function handleFileOperation(req, res, requestUrl, roots) {
  const shareIndex = Number(requestUrl.searchParams.get('share'));
  const shareRoot = roots[shareIndex];
  if (!shareRoot) {
    sendJson(res, 404, { error: '共享文件夹不存在' });
    return;
  }

  if (requestUrl.pathname === '/api/files/upload' && req.method === 'POST') {
    const directory = requestUrl.searchParams.get('dir') || '';
    const name = validEntryName(requestUrl.searchParams.get('name'));
    if (!name) throw new Error('文件名无效');

    const target = await managedPath(shareRoot, path.join(directory, name));
    const temp = path.join(path.dirname(target), `.deepseek-upload-${randomUUID()}.tmp`);

    await new Promise((resolve, reject) => {
      const output = createWriteStream(temp, { flags: 'wx' });
      req.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      req.pipe(output);
    }).catch(async error => {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    });

    await rename(temp, target);
    sendJson(res, 200, { ok: true });
    return;
  }

  const data = await readJsonBody(req);

  if (requestUrl.pathname === '/api/files/mkdir' && req.method === 'POST') {
    const name = validEntryName(data.name);
    if (!name) throw new Error('文件夹名称无效');
    const target = await managedPath(shareRoot, path.join(data.directory || '', name));
    await mkdir(target);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === '/api/files/rename' && req.method === 'POST') {
    const name = validEntryName(data.name);
    if (!name) throw new Error('新名称无效');
    const source = await managedPath(shareRoot, data.path, { mustExist: true });
    if (source === path.resolve(shareRoot)) throw new Error('不能重命名共享根目录');
    const target = await managedPath(shareRoot, path.join(path.dirname(data.path), name));
    await rename(source, target);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === '/api/files/delete' && req.method === 'POST') {
    const target = await managedPath(shareRoot, data.path, { mustExist: true });
    if (target === path.resolve(shareRoot)) throw new Error('不能删除共享根目录');
    await rm(target, { recursive: true });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 405, { error: '不支持的操作' });
}

function fileManagerScript(shareIndex, currentPath) {
  const state = JSON.stringify({ shareIndex, currentPath }).replace(/</g, '\\u003c');
  return `<script>
const state=${state};
const status=document.querySelector('#status');
async function api(endpoint,data){
  status.textContent='处理中…';
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();
  if(!response.ok||result.error)throw new Error(result.error||'操作失败');
}
document.querySelector('#upload').addEventListener('change',async event=>{
  const files=[...event.target.files];
  for(const file of files){
    status.textContent='正在上传 '+file.name+'…';
    const query=new URLSearchParams({share:String(state.shareIndex),dir:state.currentPath,name:file.name});
    const response=await fetch('/api/files/upload?'+query,{method:'POST',body:file});
    const result=await response.json();
    if(!response.ok||result.error){status.textContent=result.error||'上传失败';return;}
  }
  location.reload();
});
document.querySelector('#new-folder').addEventListener('click',async()=>{
  const name=prompt('新文件夹名称');
  if(!name)return;
  try{await api('/api/files/mkdir?share='+state.shareIndex,{directory:state.currentPath,name});location.reload();}
  catch(error){status.textContent=error.message;}
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');
  if(!button)return;
  const itemPath=button.dataset.path;
  try{
    if(button.dataset.action==='rename'){
      const name=prompt('输入新名称',button.dataset.name);
      if(!name)return;
      await api('/api/files/rename?share='+state.shareIndex,{path:itemPath,name});
    }else{
      if(!confirm('确定删除“'+button.dataset.name+'”？此操作无法撤销。'))return;
      await api('/api/files/delete?share='+state.shareIndex,{path:itemPath});
    }
    location.reload();
  }catch(error){status.textContent=error.message;}
});
</script>`;
}

function publicShares() {
  return shareState.folders.map((folder, index) => ({
    id: String(index),
    name: path.basename(folder) || folder,
    urlPath: `/share/${index}/`
  }));
}

function jsonResponse(res, payload) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function requestCredentials(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const [username, ...password] = Buffer.from(match[1], 'base64').toString('utf8').split(':');
    return { username, password: password.join(':') };
  } catch {
    return null;
  }
}

function requestAuthorized(req, password) {
  if (!password) return true;
  const credentials = requestCredentials(req);
  return credentials?.username === 'share' && credentials.password === password;
}

function requireAuthorization(req, res, password) {
  if (requestAuthorized(req, password)) return true;
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Basic realm="Handshake"'
  });
  res.end('需要输入共享密码。');
  return false;
}

async function handleShareRequest(req, res, root, config) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const password = decryptSharePassword(config);

  if (requestUrl.pathname === '/api/device') {
    jsonResponse(res, {
      name: config.hostName,
      port: SHARE_PORT,
      webDavPort: WEBDAV_PORT,
      webDavPath: webDavState?.mountPath || '',
      passwordRequired: Boolean(password),
      webDavAvailable: Boolean(webDavState)
    });
    return;
  }

  if (requestUrl.pathname.startsWith('/api/files/')) {
    if (!requireAuthorization(req, res, password)) return;
    try {
      await handleFileOperation(req, res, requestUrl, root);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === '/api/shares') {
    if (!requireAuthorization(req, res, password)) return;
    jsonResponse(res, {
      name: config.hostName,
      port: SHARE_PORT,
      webDavPort: WEBDAV_PORT,
      webDavPath: webDavState?.mountPath || '',
      passwordRequired: Boolean(password),
      webDavAvailable: Boolean(webDavState),
      shares: publicShares()
    });
    return;
  }

  if (requestUrl.pathname === '/') {
    if (!requireAuthorization(req, res, password)) return;
    const rows = publicShares().map(item => {
      return `<li><a href="${item.urlPath}">[dir] ${escapeHtml(item.name)}</a><span class="muted">共享文件夹</span></li>`;
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlPage('握手文件共享', [
      '<h1>握手文件共享</h1>',
      `<ul>${rows.join('') || '<li><span class="muted">没有共享文件夹。</span></li>'}</ul>`
    ].join('')));
    return;
  }

  const match = requestUrl.pathname.match(/^\/share\/(\d+)(\/.*)?$/);
  if (!match) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('文件不存在。');
    return;
  }

  const shareIndex = Number(match[1]);
  if (!requireAuthorization(req, res, password)) return;
  const shareRoot = root[shareIndex];
  if (!shareRoot) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('共享文件夹不存在。');
    return;
  }

  let target;
  let info;
  try {
    target = await managedPath(shareRoot, match[2] || '/', { mustExist: true });
    info = await stat(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('文件不存在。');
    return;
  }

  if (info.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true });
    const parentPath = path.relative(shareRoot, path.dirname(target));
    const currentPath = path.relative(shareRoot, target);
    const rows = [];

    if (target !== path.resolve(shareRoot)) {
      rows.push(`<li><a href="/share/${shareIndex}${toHref(parentPath, true)}">../</a><span class="muted">返回上级</span></li>`);
    }

    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      const relativePath = path.join(currentPath, entry.name);
      const href = `/share/${shareIndex}${toHref(relativePath, entry.isDirectory())}`;
      const safePath = escapeHtml(relativePath);
      const safeName = escapeHtml(entry.name);
      rows.push([
        '<li>',
        `<a class="entry" href="${href}">${entry.isDirectory() ? '[dir]' : '[file]'} ${safeName}</a>`,
        '<span class="actions">',
        `<button type="button" data-action="rename" data-path="${safePath}" data-name="${safeName}">重命名</button>`,
        `<button class="danger" type="button" data-action="delete" data-path="${safePath}" data-name="${safeName}">删除</button>`,
        '</span>',
        '</li>'
      ].join(''));
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlPage('握手文件共享', [
      '<div class="page-head"><div>',
      '<h1>握手文件共享</h1>',
      `<p class="muted">${escapeHtml(currentPath || '/')}</p></div>`,
      '<span class="muted">双向管理</span></div>',
      '<div class="toolbar">',
      '<label class="upload">上传文件<input id="upload" type="file" multiple /></label>',
      '<button id="new-folder" type="button">新建文件夹</button>',
      '</div>',
      '<div id="status" class="status"></div>',
      `<ul>${rows.join('') || '<li><span class="muted">这个文件夹是空的。</span></li>'}</ul>`,
      fileManagerScript(shareIndex, currentPath)
    ].join('')));
    return;
  }

  if (!info.isFile()) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('只能访问普通文件。');
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`
  });
  createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res);
}

async function startShareServer(folders, suppliedConfig = null) {
  const resolvedFolders = [...new Set([].concat(folders).filter(Boolean).map(folder => path.resolve(folder)))];
  const config = suppliedConfig || await readConfig();

  await stopShareServer();

  try {
    for (const folder of resolvedFolders) {
      const folderInfo = await stat(folder);
      if (!folderInfo.isDirectory()) throw new Error(`${folder} 不是文件夹`);
    }

    shareServer = http.createServer((req, res) => {
      handleShareRequest(req, res, resolvedFolders, config).catch(error => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`共享服务错误：${error.message}`);
      });
    });

    await new Promise((resolve, reject) => {
      shareServer.once('error', reject);
      shareServer.listen(SHARE_PORT, '0.0.0.0', resolve);
    });

    const password = decryptSharePassword(config);
    webDavState = await startWebDav({
      folders: resolvedFolders,
      password,
      port: WEBDAV_PORT,
      pathModule: path,
      deviceName: config.hostName
    });

    shareState = {
      running: true,
      folders: resolvedFolders,
      port: SHARE_PORT,
      webDavPort: WEBDAV_PORT,
      passwordRequired: Boolean(password),
      hostName: config.hostName,
      urls: getLanAddresses(SHARE_PORT),
      error: ''
    };
  } catch (error) {
    if (shareServer) shareServer.close();
    shareServer = null;
    shareState = {
      running: false,
      folders: resolvedFolders,
      port: SHARE_PORT,
      urls: [],
      error: error.message
    };
  }

  return shareState;
}

async function stopShareServer() {
  await stopWebDav(webDavState);
  webDavState = null;
  if (!shareServer) {
    shareState = { ...shareState, running: false, urls: [] };
    return shareState;
  }

  await new Promise(resolve => shareServer.close(resolve));
  shareServer = null;
  shareState = { ...shareState, running: false, urls: [], error: '' };
  return shareState;
}

async function isPortOpen(host, port, timeout = 500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function fetchJson(host, requestPath, password = '') {
  return new Promise(resolve => {
    const request = http.get({
      host,
      port: SHARE_PORT,
      path: requestPath,
      headers: password
        ? { authorization: `Basic ${Buffer.from(`share:${password}`).toString('base64')}` }
        : {},
      timeout: 800
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
      });
      response.on('end', () => {
        if (response.statusCode === 401) {
          resolve({ unauthorized: true });
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

async function fetchAppShares(host, password = '', includeShares = false) {
  const device = await fetchJson(host, '/api/device');
  if (!device) return null;

  if (!includeShares) {
    return {
      type: 'handshake',
      name: device.name || host,
      host,
      paired: !device.passwordRequired,
      passwordRequired: device.passwordRequired,
      webDavAvailable: device.webDavAvailable,
      webDavPath: device.webDavPath,
      webDavPort: device.webDavPort || WEBDAV_PORT,
      shares: []
    };
  }

  const data = await fetchJson(host, '/api/shares', password);
  if (data?.unauthorized) throw new Error('共享密码不正确');
  if (!data) return null;
  return {
    type: 'handshake',
    name: data.name || host,
    host,
    paired: true,
    password,
    webDavAvailable: data.webDavAvailable,
    webDavPath: data.webDavPath,
    webDavUrl: `http://${host}:${data.webDavPort || WEBDAV_PORT}${data.webDavPath || '/'}`,
    shares: (data.shares || []).map(item => ({
      ...item,
      openUrl: `http://${host}:${SHARE_PORT}${item.urlPath || '/'}`
    }))
  };
}

async function listSmbShares(host) {
  if (process.platform !== 'darwin') return [];

  return new Promise(resolve => {
    execFile('smbutil', ['view', '-g', `//${host}`], { timeout: 4000 }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }

      const shares = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('Share') && !line.startsWith('-'))
        .map(line => line.split(/\s+/)[0])
        .filter(name => name && !name.endsWith('$'))
        .map(name => ({ name, openUrl: `smb://${host}/${encodeURIComponent(name)}` }));

      resolve(shares);
    });
  });
}

async function discoverNetworkShares() {
  const hosts = getLanHosts();
  const found = [];
  const limit = 64;

  for (let index = 0; index < hosts.length; index += limit) {
    const batch = hosts.slice(index, index + limit);
    const results = await Promise.all(batch.map(async host => {
      const hasAppShare = await isPortOpen(host, SHARE_PORT);

      if (hasAppShare) {
        const appShares = await fetchAppShares(host);
        if (appShares) return appShares;
      }

      return null;
    }));

    found.push(...results.filter(Boolean));
  }

  return found;
}

function normalizeHost(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  try {
    const parsed = new URL(input.includes('://') ? input : `http://${input}`);
    return parsed.hostname;
  } catch {
    return '';
  }
}

function runFile(command, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function listWindowsNetworkDrives() {
  const command = [
    '$items = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=4"',
    '$items | Select-Object DeviceID,ProviderName | ConvertTo-Json -Compress'
  ].join('; ');
  const output = await runFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command
  ]).catch(() => '');
  if (!output.trim()) return [];

  try {
    const parsed = JSON.parse(output.replace(/^\uFEFF/, '').trim());
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(item => ({
        drive: String(item.DeviceID || '').toUpperCase(),
        provider: String(item.ProviderName || '')
      }))
      .filter(item => /^[A-Z]:$/.test(item.drive));
  } catch {
    return [];
  }
}

function driveMatchesHosts(drive, hosts) {
  const provider = drive.provider.toLocaleLowerCase();
  return hosts.some(host => {
    const normalized = String(host || '').toLocaleLowerCase();
    return normalized && (
      provider.includes(`\\\\${normalized}@${WEBDAV_PORT}\\`) ||
      provider.includes(`http://${normalized}:${WEBDAV_PORT}`)
    );
  });
}

async function preferredWindowsMountHost(ipAddress, deviceName) {
  const cleanName = String(deviceName || '').trim().replace(/\s+/g, '-');
  const candidates = cleanName
    ? cleanName.endsWith('.local')
      ? [cleanName]
      : [cleanName, `${cleanName}.local`]
    : [];

  for (const candidate of candidates) {
    if (await isPortOpen(candidate, WEBDAV_PORT, 1000)) return candidate;
  }
  return ipAddress;
}

async function reuseWindowsWebDavDrive(hosts, preferredHost) {
  const matches = (await listWindowsNetworkDrives())
    .filter(drive => driveMatchesHosts(drive, hosts));
  if (matches.length === 0) return '';

  const preferred = matches.find(drive => driveMatchesHosts(drive, [preferredHost]));
  if (!preferred) {
    for (const oldMapping of matches) {
      await runFile('net', ['use', oldMapping.drive, '/delete', '/y']).catch(() => {});
    }
    return '';
  }

  const keep = preferred;
  const duplicates = matches.filter(item => item.drive !== keep.drive);
  for (const duplicate of duplicates) {
    await runFile('net', ['use', duplicate.drive, '/delete', '/y']).catch(() => {});
  }
  return keep.drive;
}

async function mountNetworkShare(hostValue, password, mountPath = '', deviceName = '') {
  const host = normalizeHost(hostValue);
  if (!host) throw new Error('需要有效的 IP 地址');
  const mountHost = process.platform === 'win32'
    ? await preferredWindowsMountHost(host, deviceName)
    : host;
  const encodedPath = String(mountPath || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const url = `http://${mountHost}:${WEBDAV_PORT}/${encodedPath ? `${encodedPath}/` : ''}`;

  if (process.platform === 'darwin') {
    const script = password
      ? [
          `mount volume "${appleScriptString(url)}"`,
          'as user name "share"',
          `with password "${appleScriptString(password)}"`
        ].join(' ')
      : `mount volume "${appleScriptString(url)}"`;
    await runFile('osascript', ['-e', script], 30000);
    await runFile('open', ['/Volumes']).catch(() => {});
    return { url, mounted: true };
  }

  if (process.platform === 'win32') {
    const matchingHosts = [host, mountHost];
    const existingDrive = await reuseWindowsWebDavDrive(matchingHosts, mountHost);
    if (existingDrive) {
      await runFile('explorer.exe', [`${existingDrive}\\`]).catch(() => {});
      return { url, mounted: true, drive: existingDrive, reused: true };
    }

    const args = ['use', '*', url];
    if (password) args.push('/user:share', password);
    args.push('/persistent:no');
    const output = await runFile('net', args, 30000);
    const drive = output.match(/\b([A-Z]:)\b/i)?.[1]
      || await reuseWindowsWebDavDrive(matchingHosts, mountHost);
    if (drive) await runFile('explorer.exe', [`${drive}\\`]).catch(() => {});
    return { url, mounted: true, drive };
  }

  throw new Error('当前系统暂不支持自动挂载');
}

async function unmountNetworkShare(drive) {
  if (process.platform !== 'win32') throw new Error('当前仅支持从 Windows 客户端断开盘符');
  const target = String(drive || '').trim().toUpperCase();
  if (!/^[A-Z]:$/.test(target)) throw new Error('没有可断开的网络盘符');
  await runFile('net', ['use', target, '/delete', '/y'], 15000);
  return { unmounted: true, drive: target };
}

async function connectNetworkShare(value, password = '') {
  const host = normalizeHost(value);
  if (!host) throw new Error('请输入有效的 Windows IP 地址');

  const appShare = await fetchAppShares(host, password, true);
  if (appShare) return appShare;

  if (await isPortOpen(host, 445, 1200)) {
    return {
      type: 'smb',
      name: host,
      host,
      shares: await listSmbShares(host),
      openUrl: `smb://${host}`
    };
  }

  throw new Error(`无法连接 ${host}，请检查两台电脑是否在同一局域网以及 Windows 防火墙设置`);
}

function createMenu() {
  const template = [
    {
      label: process.platform === 'darwin' ? '握手' : 'File',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? [
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' }
            ]
          : []),
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 520,
    minHeight: 620,
    title: '握手',
    backgroundColor: '#101114',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 16, y: 16 }
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('config:load', () => readConfig());
ipcMain.handle('config:save', (_event, config) => saveConfig(config));
ipcMain.handle('share:status', () => shareState);
ipcMain.handle('share:start', async (_event, folder) => startShareServer(folder));
ipcMain.handle('share:stop', () => stopShareServer());
ipcMain.handle('share:discover', () => discoverNetworkShares());
ipcMain.handle('share:connect', (_event, host, password) => connectNetworkShare(host, password));
ipcMain.handle('share:mount', (_event, host, password, mountPath, deviceName) => {
  return mountNetworkShare(host, password, mountPath, deviceName);
});
ipcMain.handle('share:unmount', (_event, drive) => unmountNetworkShare(drive));
ipcMain.handle('share:open', (_event, targetUrl) => shell.openExternal(targetUrl));

ipcMain.handle('identity:set-password', async (_event, password) => {
  const value = String(password || '');
  if (value.length < 6) throw new Error('共享密码至少需要 6 位');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储暂不可用');
  const config = await readConfig();
  config.sharePasswordEncrypted = safeStorage.encryptString(value).toString('base64');
  return saveConfig(config);
});

ipcMain.handle('share:add-folder', async () => {
  const config = await readConfig();
  const result = await dialog.showOpenDialog({
    title: '添加共享文件夹',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) return config;

  config.sharedFolders = [...new Set([...config.sharedFolders, path.resolve(result.filePaths[0])])];
  return saveConfig(config);
});

ipcMain.handle('share:remove-folder', async (_event, folder) => {
  const config = await readConfig();
  const resolvedFolder = path.resolve(folder);
  config.sharedFolders = config.sharedFolders.filter(item => path.resolve(item) !== resolvedFolder);
  return saveConfig(config);
});

ipcMain.handle('folder:select', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择共享文件夹',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) return '';
  return result.filePaths[0];
});

app.whenReady().then(() => {
  createMenu();
  createWindow();
  readConfig().then(config => {
    if (config.sharedFolders.length > 0) startShareServer(config.sharedFolders);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
