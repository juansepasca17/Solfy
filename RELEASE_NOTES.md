**Solfy v0.1.1** corrige el congelamiento con canciones largas.

**Corregido**
- La app se quedaba en "No responde" al terminar de procesar algunas canciones (por ejemplo, Gitana de 6 minutos). La causa era que en el modo Aprendizaje la primera nota podía quedar con un tiempo negativo, y eso dejaba en un bucle infinito al generador de MIDI. Se corrigió en el motor y, además, el generador de MIDI ahora descarta tiempos inválidos en lugar de colgarse.
- El proceso principal de la app ya no hace trabajo pesado de forma síncrona al terminar una canción.

**Mejoras**
- El motor corre con prioridad baja: puedes seguir usando la app y la PC mientras procesa.
- La tarjeta muestra el tiempo restante estimado y, al final, cuánto tardó el procesamiento.
- Si el motor deja de responder durante 10 minutos, la canción se marca con error en lugar de quedarse esperando para siempre.
- Cada canción guarda un registro local (`engine.log`) con el tiempo de cada etapa, útil para diagnosticar problemas.

**Instalación:** descarga `Solfy-Setup-0.1.1.exe`. El instalador no está firmado, así que SmartScreen muestra un aviso: *Más información → Ejecutar de todas formas*.
