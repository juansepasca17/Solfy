**Solfy v0.2.0** agrega el procesamiento con GPU (DirectML).

**Novedades**
- **Modo GPU con DirectML:** funciona con cualquier GPU DirectX 12 en Windows (AMD, Intel o NVIDIA). Con *Gitana* (6:54) en una Radeon RX 6550M, el procesamiento pasó de ~13 minutos en CPU a **~3 minutos**, con la letra incluida.
- **Ajustes → Procesamiento de canciones:** Automático (GPU si hay; si no, CPU), Normal (CPU) o GPU. En Ajustes se muestra qué GPU se detectó.
- **Red de seguridad:** si la GPU falla a mitad del proceso, la canción se termina en CPU automáticamente.
- Con la letra activada, en modo GPU Whisper transcribe en la CPU al mismo tiempo que la GPU detecta la melodía.
- Cada tarjeta indica cuánto tardó el procesamiento y si se usó GPU o CPU.

**Detalles**
- El modo Normal (CPU) es exactamente el mismo de antes. Las notas de los dos modos coinciden en un ~96 %.
- El instalador pesa unos 250 MB más, porque incluye los modelos del modo GPU. Todo sigue funcionando sin internet.

**Instalación:** descarga `Solfy-Setup-0.2.0.exe`. El instalador no está firmado, así que SmartScreen muestra un aviso: *Más información → Ejecutar de todas formas*.
