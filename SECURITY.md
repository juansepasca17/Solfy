# Seguridad

## Medidas

- **Electron endurecido:** `contextIsolation`, `sandbox` y sin `nodeIntegration`. La interfaz se sirve desde un protocolo propio (`app://solfy`) con una CSP estricta (`default-src 'self'`). Se bloquean la navegación, las ventanas nuevas, los `<webview>` y las descargas. Las DevTools están desactivadas en el instalador.
- **IPC mínimo:** el preload expone solo funciones concretas. El proceso principal comprueba el origen de cada llamada, valida los IDs (UUID) para evitar path traversal, y valida y limpia las notas, la letra y los puntajes antes de escribirlos.
- **Entrada:** solo `.mp3`, verificado por la extensión y por los bytes mágicos (ID3 / frame sync MPEG), con un límite de 60 MB y 15 minutos.
- **Motor:** se lanza sin shell, con un array de argumentos y un entorno reducido (no hereda tus variables). Es offline y no descarga modelos en tiempo de ejecución.
- **Build:** dependencias fijadas, la integridad del modelo Demucs se verifica por SHA256, y el workflow de releases publica el SHA256 del instalador. Dependabot revisa npm, pip y Actions cada mes.

## Reportar un problema

Abre un issue en <https://github.com/juansepasca17/Solfy/issues>. Si es sensible, usa **Security → Report a vulnerability** en el repositorio (reporte privado).
