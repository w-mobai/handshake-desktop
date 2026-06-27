const state = {
  config: {
    sharedFolders: [],
    hostName: '这台电脑'
  },
  shareStatus: null,
  contextFolder: '',
  devices: [],
  pairingDevice: null
};

const computerName = document.querySelector('#computerName');
const addShare = document.querySelector('#addShare');
const localShares = document.querySelector('#localShares');
const refreshNetwork = document.querySelector('#refreshNetwork');
const networkStatus = document.querySelector('#networkStatus');
const networkShares = document.querySelector('#networkShares');
const directConnect = document.querySelector('#directConnect');
const windowsHost = document.querySelector('#windowsHost');
const remotePassword = document.querySelector('#remotePassword');
const connectButton = document.querySelector('#connectButton');
const editComputerName = document.querySelector('#editComputerName');
const setSharePassword = document.querySelector('#setSharePassword');
const localStatus = document.querySelector('#localStatus');
const passwordDialog = document.querySelector('#passwordDialog');
const passwordForm = document.querySelector('#passwordForm');
const newSharePassword = document.querySelector('#newSharePassword');
const passwordError = document.querySelector('#passwordError');
const savePassword = document.querySelector('#savePassword');
const cancelPassword = document.querySelector('#cancelPassword');
const pairDialog = document.querySelector('#pairDialog');
const pairForm = document.querySelector('#pairForm');
const pairDeviceName = document.querySelector('#pairDeviceName');
const pairDeviceAddress = document.querySelector('#pairDeviceAddress');
const pairPassword = document.querySelector('#pairPassword');
const pairError = document.querySelector('#pairError');
const confirmPair = document.querySelector('#confirmPair');
const cancelPair = document.querySelector('#cancelPair');
const folderMenu = document.querySelector('#folderMenu');
const unshareFolder = document.querySelector('#unshareFolder');

function folderName(folder) {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder;
}

function folderButton(label) {
  const button = document.createElement('button');
  const icon = document.createElement('span');
  const text = document.createElement('span');

  button.className = 'folder-row';
  button.type = 'button';
  icon.className = 'folder-icon';
  icon.setAttribute('aria-hidden', 'true');
  text.textContent = label;
  button.append(icon, text);
  return button;
}

function localShareUrl(index) {
  const baseUrl = state.shareStatus?.urls?.[0];
  if (!baseUrl) return '';
  return `${baseUrl}/share/${index}/`;
}

function closeContextMenu() {
  folderMenu.removeAttribute('open');
  state.contextFolder = '';
}

function renderLocalShares() {
  computerName.textContent = state.config.hostName || '这台电脑';
  setSharePassword.textContent = state.shareStatus?.passwordRequired ? '修改密码' : '设置密码';
  localStatus.textContent = state.shareStatus?.passwordRequired
    ? '已启用密码保护'
    : '共享密码尚未设置';
  localStatus.classList.toggle('is-secure', Boolean(state.shareStatus?.passwordRequired));
  localShares.replaceChildren();

  if (!state.config.sharedFolders?.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '还没有共享文件夹';
    localShares.append(empty);
    return;
  }

  state.config.sharedFolders.forEach((folder, index) => {
    const item = document.createElement('li');
    const button = folderButton(folderName(folder));
    const time = document.createElement('span');
    const url = localShareUrl(index);

    button.title = folder;
    button.addEventListener('click', () => {
      if (url) window.deepseekDesktop.openShare(url);
    });
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      state.contextFolder = folder;
      folderMenu.style.left = `${event.clientX}px`;
      folderMenu.style.top = `${event.clientY}px`;
      folderMenu.setAttribute('open', '');
    });

    time.className = 'muted';
    time.textContent = '共享中';
    item.append(button, time);
    localShares.append(item);
  });
}

function renderNetworkDevices(devices) {
  state.devices = devices;
  networkShares.replaceChildren();

  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'empty network-empty';
    empty.textContent = '没有发现局域网共享';
    networkShares.append(empty);
    return;
  }

  for (const device of devices) {
    const group = document.createElement('section');
    const head = document.createElement('div');
    const title = document.createElement('h3');
    const meta = document.createElement('span');
    const deviceActions = document.createElement('div');
    const list = document.createElement('ul');

    group.className = 'device-group';
    head.className = 'device-head';
    title.textContent = device.name || device.host;
    meta.textContent = device.host;
    deviceActions.className = 'device-actions';
    deviceActions.append(meta);

    if (device.paired && device.webDavAvailable) {
      const mount = document.createElement('button');
      mount.className = 'mini-button';
      mount.type = 'button';
      mount.textContent = '挂载';
      mount.addEventListener('click', async () => {
        networkStatus.textContent = `正在挂载 ${device.name || device.host}...`;
        try {
          await window.deepseekDesktop.mountShare(device.host, device.password, device.webDavPath);
          networkStatus.textContent = '已挂载到系统文件管理器';
        } catch (error) {
          networkStatus.textContent = `挂载失败：${error.message}`;
        }
      });
      deviceActions.append(mount);
    }

    head.append(title, deviceActions);
    list.className = 'file-list';

    if (device.shares?.length) {
      for (const share of device.shares) {
        const item = document.createElement('li');
        const button = folderButton(share.name);
        const detail = document.createElement('span');

        button.addEventListener('click', () => window.deepseekDesktop.openShare(share.openUrl));
        detail.className = 'muted';
        detail.textContent = '打开';
        item.append(button, detail);
        list.append(item);
      }
    } else if (device.type === 'handshake') {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const detail = document.createElement('span');

      button.className = 'pair-button';
      button.type = 'button';
      button.textContent = device.passwordRequired ? '输入密码配对' : '打开共享';
      button.addEventListener('click', async () => {
        if (device.passwordRequired) {
          state.pairingDevice = device;
          pairDeviceName.textContent = device.name || '输入共享密码';
          pairDeviceAddress.textContent = device.host;
          pairPassword.value = '';
          pairError.textContent = '';
          pairDialog.showModal();
          pairPassword.focus();
          return;
        }

        await pairWithDevice(device, '');
      });
      detail.className = 'muted';
      detail.textContent = device.passwordRequired ? '需要密码' : '无需密码';
      item.append(button, detail);
      list.append(item);
    } else {
      const item = document.createElement('li');
      const button = folderButton('查看共享');
      const detail = document.createElement('span');

      button.addEventListener('click', () => window.deepseekDesktop.openShare(device.openUrl || `smb://${device.host}`));
      detail.className = 'muted';
      detail.textContent = '需要登录';
      item.append(button, detail);
      list.append(item);
    }

    group.append(head, list);
    networkShares.append(group);
  }
}

async function pairWithDevice(device, password) {
  networkStatus.textContent = `正在连接 ${device.name || device.host}...`;
  const paired = await window.deepseekDesktop.connectShare(device.host, password);
  const next = state.devices.map(itemDevice => itemDevice.host === device.host ? paired : itemDevice);
  renderNetworkDevices(next);
  networkStatus.textContent = `已与 ${paired.name || device.host} 配对`;
  return paired;
}

async function refreshStatus() {
  state.shareStatus = await window.deepseekDesktop.getShareStatus();
  renderLocalShares();
}

async function discover() {
  refreshNetwork.disabled = true;
  networkStatus.textContent = '正在扫描局域网共享...';

  try {
    const devices = await window.deepseekDesktop.discoverShares();
    renderNetworkDevices(devices);
    networkStatus.textContent = `发现 ${devices.length} 台共享设备`;
  } catch (error) {
    networkStatus.textContent = `扫描失败：${error.message}`;
  } finally {
    refreshNetwork.disabled = false;
  }
}

async function load() {
  state.config = await window.deepseekDesktop.loadConfig();
  await refreshStatus();
  discover();
}

addShare.addEventListener('click', async () => {
  state.config = await window.deepseekDesktop.addShareFolder();
  await refreshStatus();
});

refreshNetwork.addEventListener('click', discover);

directConnect.addEventListener('submit', async event => {
  event.preventDefault();
  const host = windowsHost.value.trim();
  const password = remotePassword.value;
  if (!host) {
    networkStatus.textContent = '请输入 Windows 的 IPv4 地址';
    windowsHost.focus();
    return;
  }

  connectButton.disabled = true;
  networkStatus.textContent = `正在连接 ${host}...`;

  try {
    const device = await window.deepseekDesktop.connectShare(host, password);
    renderNetworkDevices([device]);
    networkStatus.textContent = `已连接 ${device.name || host}`;
  } catch (error) {
    renderNetworkDevices([]);
    networkStatus.textContent = error.message;
  } finally {
    connectButton.disabled = false;
  }
});

editComputerName.addEventListener('click', async () => {
  const name = prompt('输入这台电脑显示给其他设备的名称', state.config.hostName || '');
  if (!name?.trim()) return;
  try {
    state.config = await window.deepseekDesktop.setComputerName(name);
    await refreshStatus();
  } catch (error) {
    networkStatus.textContent = error.message;
  }
});

setSharePassword.addEventListener('click', async () => {
  passwordError.textContent = '';
  newSharePassword.value = '';
  passwordDialog.showModal();
  newSharePassword.focus();
});

cancelPassword.addEventListener('click', () => passwordDialog.close());

passwordForm.addEventListener('submit', async event => {
  event.preventDefault();
  const password = newSharePassword.value;
  if (password.length < 6) {
    passwordError.textContent = '密码至少需要 6 位';
    return;
  }

  savePassword.disabled = true;
  passwordError.textContent = '正在保存…';
  try {
    state.config = await window.deepseekDesktop.setSharePassword(password);
    await refreshStatus();
    localStatus.textContent = '密码已保存，其他电脑现在可以配对';
    passwordDialog.close();
  } catch (error) {
    passwordError.textContent = error.message;
  } finally {
    savePassword.disabled = false;
  }
});

cancelPair.addEventListener('click', () => {
  state.pairingDevice = null;
  pairDialog.close();
});

pairForm.addEventListener('submit', async event => {
  event.preventDefault();
  const device = state.pairingDevice;
  if (!device) return;

  const password = pairPassword.value;
  if (!password) {
    pairError.textContent = '请输入共享密码';
    return;
  }

  confirmPair.disabled = true;
  pairError.textContent = '正在验证…';
  try {
    await pairWithDevice(device, password);
    state.pairingDevice = null;
    pairDialog.close();
  } catch (error) {
    pairError.textContent = error.message;
    pairPassword.select();
  } finally {
    confirmPair.disabled = false;
  }
});

unshareFolder.addEventListener('click', async () => {
  if (!state.contextFolder) return;
  state.config = await window.deepseekDesktop.removeShareFolder(state.contextFolder);
  await refreshStatus();
  closeContextMenu();
});

window.addEventListener('click', closeContextMenu);
window.addEventListener('blur', closeContextMenu);

load();
