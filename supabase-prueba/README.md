# Prueba de Acervo con Supabase

- Proyecto Supabase: `acervo-pruebas` (gratis, us-east-1).
- App: `app-supabase/` (la misma app; solo cambia `config.js`, que apunta a la función `acervo`).
- Base de datos: `001_esquema.sql` (tablas, todo cerrado al público) y `002_funciones.sql` (reglas de entrada, salida, mover, cambiar estado y agregar, cada una en un solo paso).
- Servidor: `funcion-acervo.ts` (Edge Function `acervo`): mismas acciones y respuestas que el Apps Script.
- Datos: 2 cajas y 30 muebles copiados de la copia de pruebas, con fotos, miniaturas e historial.
- Aún no está: editar, dar de baja, crear/mover/borrar/renombrar cajas. Las fichas QR impresas siguen en Google.
