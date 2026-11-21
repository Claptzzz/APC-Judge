-- El cursor de ListSubmissions serializa submitted_at con Date#toISOString (precisión de
-- milisegundos), pero la columna guardaba microsegundos: dos filas en el mismo milisegundo
-- quedaban indistinguibles en el cursor y la segunda se perdía entre páginas. Igualamos la
-- precisión de la columna a la del cursor. Postgres redondea los valores existentes y
-- reconstruye submissions_submitted_at_idx.
ALTER TABLE "submissions" ALTER COLUMN "submitted_at" SET DATA TYPE timestamp(3) with time zone;
