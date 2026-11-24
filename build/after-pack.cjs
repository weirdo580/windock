'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  const exe = path.join(context.appOutDir, 'WinDock.exe');
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');
  const rcedit = path.join(context.packager.projectDir, 'build', 'rcedit-x64.exe');
  execFileSync(rcedit, [exe, '--set-icon', icon], { windowsHide: true });
  console.log('[afterPack] WinDock.exe icon updated');
};
