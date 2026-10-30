// PM2 config: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'ollama-mern',
      cwd: './server',
      script: 'src/index.js',
      env: { NODE_ENV: 'production' },
    },
  ],
};
