# TODO - Amawta CLI

## Pendiente para fase final: MemoryService (TypeScript)

- [ ] Implementar memoria entre conversaciones/sesiones en TypeScript (no Python).
- [ ] Objetivo: recordar preferencias del usuario, hipotesis previas y patrones de analisis.
- [ ] Enfoque recomendado: `local-first` (persistencia en disco local, p. ej. `~/.amawta`) y luego opcion de backend remoto si se necesita.
- [ ] Integrar un tool de carga de memoria en el flujo del orquestador (lectura) y una estrategia de ingesta al finalizar analisis (escritura).
- [ ] Definir reglas de privacidad/retencion y comandos de control del usuario (ver, limpiar, desactivar memoria).
- [ ] Agregar tests de:
  - aislamiento por usuario/conversacion
  - persistencia entre reinicios del CLI
  - relevancia minima de recuperacion para hipotesis similares
