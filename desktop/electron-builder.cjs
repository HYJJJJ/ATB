module.exports = {
  appId: 'local.freecamera.desktop',
  productName: 'ATB',
  asar: false,
  npmRebuild: false,
  // package-atb.js supplies a clean, allowlisted application directory.
  files: ['**/*', '!**/node_modules/**/{test,tests,example,examples}/**'],
  win: { target: [{ target: 'portable', arch: ['x64'] }], signAndEditExecutable: false },
  portable: { artifactName: 'ATB-${version}-Windows-${arch}-${env.ATB_BUILD_VARIANT}.${ext}' },
};
