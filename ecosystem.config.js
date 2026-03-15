module.exports = {
  apps: [
    {
      name: 'idca-server',
      script: 'dist/index.js',
      cwd: './server',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/server-error.log',
      out_file: './logs/server-out.log',
      merge_logs: true,
      autorestart: true,
    },
  ],
};
