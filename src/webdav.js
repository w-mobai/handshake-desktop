import webdavServer from 'webdav-server';

const { v2: webdav } = webdavServer;

function uniqueMountNames(folders, pathModule) {
  const used = new Set();

  return folders.map((folder, index) => {
    const base = pathModule.basename(folder) || `共享文件夹 ${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLocaleLowerCase())) {
      name = `${base} ${suffix}`;
      suffix += 1;
    }
    used.add(name.toLocaleLowerCase());
    return name;
  });
}

export async function startWebDav({ folders, password, port, pathModule, deviceName }) {
  if (folders.length === 0) return null;

  const server = new webdav.WebDAVServer({
    hostname: '0.0.0.0',
    port,
    requireAuthentification: Boolean(password),
    serverName: 'Handshake',
    ...(password ? authenticationOptions(password) : {})
  });

  const mountName = String(deviceName || 'Handshake').replace(/[\\/]/g, '-');
  const mountPath = `/${mountName}`;
  const names = uniqueMountNames(folders, pathModule);
  if (folders.length === 1) {
    server.setFileSystemSync(
      mountPath,
      new webdav.PhysicalFileSystem(folders[0]),
      true
    );
  } else {
    server.setFileSystemSync(
      mountPath,
      new webdav.VirtualFileSystem(),
      true
    );
    folders.forEach((folder, index) => {
      server.setFileSystemSync(
        `${mountPath}/${names[index]}`,
        new webdav.PhysicalFileSystem(folder),
        true
      );
    });
  }

  await server.startAsync(port);
  return { server, names, mountPath };
}

function authenticationOptions(password) {
  const userManager = new webdav.SimpleUserManager();
  const user = userManager.addUser('share', password, false);
  const privilegeManager = new webdav.SimplePathPrivilegeManager();
  privilegeManager.setRights(user, '/', ['all']);
  return {
    httpAuthentication: new webdav.HTTPDigestAuthentication(userManager, 'Handshake'),
    privilegeManager
  };
}

export async function stopWebDav(instance) {
  if (instance?.server) await instance.server.stopAsync();
}
