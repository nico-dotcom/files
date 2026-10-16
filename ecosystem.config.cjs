// PM2 config del minio-upload-service.
// Antes corría `npm run dev` (ts-node-dev --respawn), que ejecuta el server en un
// proceso HIJO: si el server moría, PM2 (que vigilaba a npm/ts-node-dev) no lo veía
// y quedaba "online" pero sin escuchar → 502 hasta reinicio manual.
// Ahora corre el JS COMPILADO directo: PM2 vigila el server real y lo reinicia ante
// cualquier salida. Rebuild tras tocar src/: `npm run build`.
module.exports = {
  apps: [
    {
      name: 'minio-upload-service',
      script: 'dist/index.js',
      cwd: '/home/nicolas/files',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      exp_backoff_restart_delay: 500,   // reinicia con backoff creciente (no quema CPU en crash-loop)
      max_memory_restart: '350M',       // reinicia si hay leak de memoria
      kill_timeout: 8000,               // deja terminar uploads en vuelo al reiniciar
      error_file: '/home/nicolas/.pm2/logs/minio-upload-service-error.log',
      out_file: '/home/nicolas/.pm2/logs/minio-upload-service-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: { NODE_ENV: 'production' },
    },
  ],
};
