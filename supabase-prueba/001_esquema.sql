-- Acervo · PRUEBA en Supabase. Todo cerrado al público: solo la función del servidor (service role) entra.
create table public.ajustes (clave text primary key, valor jsonb not null);

create table public.admins (
  email text primary key check (email = lower(email)),
  nombre text not null default '',
  rol text not null default 'Administrador' check (rol in ('Administrador', 'Solo consulta')),
  activo boolean not null default true
);

create table public.cajas (
  codigo text primary key,
  nombre text not null default '',
  almacen text not null,
  deposito text not null default '',
  qr text not null default '',
  orden bigserial
);
create unique index cajas_codigo_ci on public.cajas (lower(codigo));

create table public.muebles (
  codigo text primary key,
  nombre text not null,
  tipo text not null default '',
  categoria text not null default '',
  material text not null default '',
  medidas text not null default '',
  color text not null default '',
  descripcion text not null default '',
  foto_catalogo text,            -- ruta en el almacén de fotos (bucket «fotos»)
  foto_real text,
  mini text,                     -- foto pequeña (texto data:image/jpeg…)
  mini_v text not null default '',
  qr text not null default '',
  creado timestamptz not null default now(),
  orden bigserial
);
create unique index muebles_codigo_ci on public.muebles (lower(codigo));
create unique index muebles_nombre_ci on public.muebles (lower(nombre));

create or replace function public.acv_clave(p_ubic text, p_dep text, p_caja text) returns text
language sql immutable set search_path = '' as $$
  select case when coalesce(p_caja, '') <> '' then 'c:' || lower(p_caja)
              else 'u:' || lower(coalesce(p_ubic, '')) || '|' || lower(coalesce(p_dep, '')) end
$$;

-- Dónde está cada mueble y cuántas unidades hay ahí por estado: {"Buen estado": 3, "Mal estado": 1}
create table public.lugares (
  id bigserial primary key,
  codigo text not null references public.muebles (codigo) on update cascade on delete cascade,
  ubic text not null,
  dep text not null default '',
  caja text not null default '',
  cant jsonb not null default '{}'::jsonb,
  clave text generated always as (public.acv_clave(ubic, dep, caja)) stored,
  unique (codigo, clave)
);
create index lugares_caja on public.lugares (lower(caja)) where caja <> '';

create table public.historial (
  id bigserial primary key,
  cuando timestamptz not null default now(),
  usuario text not null default '',
  correo text not null default '',
  codigo text not null default '',
  mueble text not null default '',
  accion text not null,
  antes text not null default '',
  despues text not null default '',
  detalle text not null default '',
  importado boolean not null default false
);
create index historial_codigo on public.historial (lower(codigo), id desc);

create table public.movimientos (
  id bigserial primary key,
  cuando timestamptz not null default now(),
  codigo text not null,
  mueble text not null,
  movimiento text not null,
  cantidad int not null,
  estado text not null default '',
  estado_nuevo text not null default '',
  ubicacion text not null default '',
  ubicacion_nueva text not null default '',
  usuario text not null default '',
  correo text not null default '',
  nota text not null default ''
);

alter table public.ajustes enable row level security;
alter table public.admins enable row level security;
alter table public.cajas enable row level security;
alter table public.muebles enable row level security;
alter table public.lugares enable row level security;
alter table public.historial enable row level security;
alter table public.movimientos enable row level security;
revoke all on public.ajustes, public.admins, public.cajas, public.muebles, public.lugares, public.historial, public.movimientos from anon, authenticated;

-- Clave para firmar las sesiones de la app (se crea sola, nadie la escribe a mano).
insert into public.ajustes values ('clave_sesion', to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')));
insert into public.ajustes values ('listas', '{"ubicaciones":[],"depositos":[],"tipos":[],"categorias":[],"estados":["Buen estado","Mal estado","Se debe mandar a reparación","En reparación"]}');

-- Almacén de fotos: público para LEER (nombres al azar), solo el servidor sube.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
