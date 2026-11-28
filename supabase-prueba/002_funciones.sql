-- Reglas de cada cambio (las mismas del panel del Excel), cada una en un solo paso: o se hace todo o nada.

create or replace function public.acv_en_estado(e text) returns text
language sql immutable set search_path = '' as $$
  select case
    when btrim(e) = 'Se debe mandar a reparación' then 'por mandar a reparación'
    when btrim(e) ~* '^(en|por|sin|con|a|para)\s' then lower(btrim(e))
    when btrim(e) ~* 'estado$' then 'en ' || lower(btrim(e))
    else lower(btrim(e)) end
$$;

create or replace function public.acv_estados() returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array(select jsonb_array_elements_text(valor -> 'estados') from public.ajustes where clave = 'listas'), '{}')
$$;

create or replace function public.acv_suma(c jsonb) returns int
language sql immutable set search_path = '' as $$
  select coalesce(sum((v)::int), 0)::int from jsonb_each_text(coalesce(c, '{}'::jsonb)) as t(k, v)
$$;

create or replace function public.acv_desglose(c jsonb) returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(string_agg(n || ' ' || public.acv_en_estado(e), ' · ' order by i), ''), 'sin unidades')
  from (select e, i, coalesce((c ->> e)::int, 0) as n from unnest(public.acv_estados()) with ordinality as x(e, i)) s
  where n > 0
$$;

create or replace function public.acv_total(p_codigo text) returns int
language sql stable set search_path = '' as $$
  select coalesce(sum(public.acv_suma(cant)), 0)::int from public.lugares where codigo = p_codigo
$$;

create or replace function public.acv_sumar(c jsonb, e text, n int) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(c, '{}'::jsonb) || jsonb_build_object(e, coalesce((c ->> e)::int, 0) + n)
$$;

create or replace function public.acv_hist(p jsonb, p_codigo text, p_mueble text, p_accion text, p_antes text, p_despues text, p_detalle text) returns void
language sql set search_path = '' as $$
  insert into public.historial (usuario, correo, codigo, mueble, accion, antes, despues, detalle)
  values (coalesce(p ->> 'usuario', ''), coalesce(p ->> 'correo', ''), p_codigo, p_mueble, p_accion, coalesce(p_antes, ''), coalesce(p_despues, ''), coalesce(p_detalle, ''))
$$;

create or replace function public.acv_mov(p jsonb, p_codigo text, p_mueble text, p_tipo text, p_cant int, p_estado text, p_estado_nuevo text, p_ubic text, p_ubic_nueva text) returns void
language sql set search_path = '' as $$
  insert into public.movimientos (codigo, mueble, movimiento, cantidad, estado, estado_nuevo, ubicacion, ubicacion_nueva, usuario, correo, nota)
  values (p_codigo, p_mueble, p_tipo, p_cant, coalesce(p_estado, ''), coalesce(p_estado_nuevo, ''), coalesce(p_ubic, ''), coalesce(p_ubic_nueva, ''),
          coalesce(p ->> 'usuario', ''), coalesce(p ->> 'correo', ''), coalesce(p ->> 'nota', ''))
$$;

-- El mueble (bloqueado mientras dura el cambio, así dos personas a la vez no se pisan).
create or replace function public.acv_mueble_bloqueado(p_codigo text, out codigo text, out nombre text)
language plpgsql set search_path = '' as $$
begin
  select m.codigo, m.nombre into codigo, nombre from public.muebles m where lower(m.codigo) = lower(btrim(p_codigo)) for update;
  if not found then raise exception 'No hay ningún mueble con el código %.', btrim(p_codigo); end if;
end $$;

/* Entrada o salida. p: {codigo, tipo: Entrada|Salida, ubic, dep, caja, lugar (texto), cant, estado, nota, usuario, correo} */
create or replace function public.acv_registrar(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  m record; l public.lugares%rowtype;
  v_tipo text := p ->> 'tipo'; v_est text := p ->> 'estado'; v_cant int := (p ->> 'cant')::int; v_lug text := p ->> 'lugar';
  v_nota text := coalesce(p ->> 'nota', ''); v_hay int; v_total int; v_verbo text; v_quedan int;
begin
  select * into m from public.acv_mueble_bloqueado(p ->> 'codigo');
  select * into l from public.lugares x where x.codigo = m.codigo and x.clave = public.acv_clave(p ->> 'ubic', p ->> 'dep', p ->> 'caja') for update;
  if v_tipo = 'Salida' then
    if l.id is null then raise exception '«%» no tiene unidades en %.', m.nombre, v_lug; end if;
    v_hay := coalesce((l.cant ->> v_est)::int, 0);
    if v_cant > v_hay then
      raise exception 'En % solo hay % de «%» %. No se pueden sacar %.', v_lug, v_hay, m.nombre, public.acv_en_estado(v_est), v_cant;
    end if;
  end if;
  if l.id is null then
    insert into public.lugares (codigo, ubic, dep, caja) values (m.codigo, p ->> 'ubic', coalesce(p ->> 'dep', ''), coalesce(p ->> 'caja', '')) returning * into l;
  end if;
  update public.lugares set cant = public.acv_sumar(cant, v_est, case when v_tipo = 'Entrada' then v_cant else -v_cant end)
   where id = l.id returning public.acv_suma(cant) into v_quedan;
  if v_tipo = 'Salida' and v_quedan = 0 and (select count(*) from public.lugares where codigo = m.codigo) > 1 then
    delete from public.lugares where id = l.id;
  end if;
  v_total := public.acv_total(m.codigo);
  perform public.acv_mov(p, m.codigo, m.nombre, v_tipo, v_cant, v_est, '', v_lug, '');
  v_verbo := case when v_tipo = 'Entrada' then (case when v_cant = 1 then 'Entró 1' else 'Entraron ' || v_cant end)
                  else (case when v_cant = 1 then 'Salió 1' else 'Salieron ' || v_cant end) end;
  perform public.acv_hist(p, m.codigo, m.nombre, v_tipo || ' de unidades', '', '',
    v_verbo || ' ' || public.acv_en_estado(v_est) || ' · ' || (case when v_tipo = 'Entrada' then 'a ' else 'de ' end) || v_lug ||
    ' · total ahora ' || v_total || (case when v_nota <> '' then ' · ' || v_nota else '' end));
  return jsonb_build_object('codigo', m.codigo, 'mensaje',
    v_verbo || ' de «' || m.nombre || '» ' || (case when v_tipo = 'Entrada' then 'a ' else 'de ' end) || v_lug || '. Total del mueble: ' || v_total || '.');
end $$;

/* Cambiar estado. p: {codigo, ubic, dep, caja, lugar, cant, de, a, nota, usuario, correo} */
create or replace function public.acv_cambiar_estado(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  m record; l public.lugares%rowtype; v_de text := p ->> 'de'; v_a text := p ->> 'a'; v_cant int := (p ->> 'cant')::int;
  v_lug text := p ->> 'lugar'; v_nota text := coalesce(p ->> 'nota', ''); v_hay int; v_c jsonb; v_u text;
begin
  select * into m from public.acv_mueble_bloqueado(p ->> 'codigo');
  select * into l from public.lugares x where x.codigo = m.codigo and x.clave = public.acv_clave(p ->> 'ubic', p ->> 'dep', p ->> 'caja') for update;
  if l.id is null then raise exception '«%» no tiene unidades en %.', m.nombre, v_lug; end if;
  v_hay := coalesce((l.cant ->> v_de)::int, 0);
  if v_cant > v_hay then raise exception 'En % solo hay % de «%» %.', v_lug, v_hay, m.nombre, public.acv_en_estado(v_de); end if;
  update public.lugares set cant = public.acv_sumar(public.acv_sumar(cant, v_de, -v_cant), v_a, v_cant) where id = l.id returning cant into v_c;
  v_u := case when v_cant = 1 then '1 unidad' else v_cant || ' unidades' end;
  perform public.acv_mov(p, m.codigo, m.nombre, 'Cambio de estado', v_cant, v_de, v_a, v_lug, '');
  perform public.acv_hist(p, m.codigo, m.nombre, 'Cambio de estado', v_de, v_a,
    v_u || ' en ' || v_lug || (case when v_nota <> '' then ' · ' || v_nota else '' end) || ' · ahora ahí: ' || public.acv_desglose(v_c));
  return jsonb_build_object('codigo', m.codigo, 'mensaje',
    v_u || ' de «' || m.nombre || '» en ' || v_lug || (case when v_cant = 1 then ' pasó' else ' pasaron' end) || ' de «' || v_de || '» a «' || v_a || '».');
end $$;

/* Mover unidades. p: {codigo, ubic, dep, caja, lugar, hUbic, hDep, hCaja, hLugar, cant, estado, nota, usuario, correo} */
create or replace function public.acv_mover(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  m record; o public.lugares%rowtype; d public.lugares%rowtype; v_est text := p ->> 'estado'; v_cant int := (p ->> 'cant')::int;
  v_desde text := p ->> 'lugar'; v_hacia text := p ->> 'hLugar'; v_nota text := coalesce(p ->> 'nota', ''); v_hay int; v_quedan int; v_u text;
begin
  select * into m from public.acv_mueble_bloqueado(p ->> 'codigo');
  select * into o from public.lugares x where x.codigo = m.codigo and x.clave = public.acv_clave(p ->> 'ubic', p ->> 'dep', p ->> 'caja') for update;
  if o.id is null then raise exception '«%» no tiene unidades en %.', m.nombre, v_desde; end if;
  v_hay := coalesce((o.cant ->> v_est)::int, 0);
  if v_cant > v_hay then raise exception 'En % solo hay % de «%» %.', v_desde, v_hay, m.nombre, public.acv_en_estado(v_est); end if;
  select * into d from public.lugares x where x.codigo = m.codigo and x.clave = public.acv_clave(p ->> 'hUbic', p ->> 'hDep', p ->> 'hCaja') for update;
  if d.id is null then
    insert into public.lugares (codigo, ubic, dep, caja) values (m.codigo, p ->> 'hUbic', coalesce(p ->> 'hDep', ''), coalesce(p ->> 'hCaja', '')) returning * into d;
  end if;
  update public.lugares set cant = public.acv_sumar(cant, v_est, -v_cant) where id = o.id returning public.acv_suma(cant) into v_quedan;
  update public.lugares set cant = public.acv_sumar(cant, v_est, v_cant) where id = d.id;
  if v_quedan = 0 then delete from public.lugares where id = o.id; end if;
  v_u := case when v_cant = 1 then '1 unidad' else v_cant || ' unidades' end;
  perform public.acv_mov(p, m.codigo, m.nombre, 'Traslado', v_cant, v_est, '', v_desde, v_hacia);
  perform public.acv_hist(p, m.codigo, m.nombre, 'Traslado', v_desde, v_hacia,
    v_u || ' ' || public.acv_en_estado(v_est) || ' · quedan ' || v_quedan || ' en ' || v_desde || (case when v_nota <> '' then ' · ' || v_nota else '' end));
  return jsonb_build_object('codigo', m.codigo, 'mensaje',
    v_u || ' de «' || m.nombre || '»' || (case when v_cant = 1 then ' se movió' else ' se movieron' end) || ' de ' || v_desde || ' a ' || v_hacia ||
    '. Quedan ' || v_quedan || ' en ' || v_desde || '.');
end $$;

/* Agregar. p: {codigo?, nombre?, tipo, categoria, material, medidas, color, descripcion, ubic, dep, caja, lugar, cant, estado,
               foto_catalogo, foto_real, mini, qrBase, usuario, correo}  — las fotos ya están subidas (rutas). */
create or replace function public.acv_agregar(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_cod text := btrim(coalesce(p ->> 'codigo', '')); v_nom text := btrim(coalesce(p ->> 'nombre', ''));
  v_cant int := (p ->> 'cant')::int; v_est text := p ->> 'estado'; v_lug text := p ->> 'lugar'; v_sin boolean; v_x text; v_fotos text;
begin
  perform pg_advisory_xact_lock(4242);   -- un alta a la vez (para que dos no tomen el mismo código)
  if v_cod <> '' and exists (select 1 from public.muebles where lower(codigo) = lower(v_cod)) then
    raise exception 'El código % ya pertenece a otro mueble. Para sumar unidades usa Entrada.', v_cod;
  end if;
  if v_nom <> '' then
    select codigo into v_x from public.muebles where lower(nombre) = lower(v_nom);
    if found then raise exception 'Ya existe «%». Para sumar unidades usa Entrada.', v_nom; end if;
  end if;
  if v_cod = '' then
    select 'ACV-' || lpad((coalesce(max((substring(codigo from '^ACV-(\d+)$'))::int), 0) + 1)::text, 4, '0') into v_cod
      from public.muebles where codigo ~* '^ACV-\d+$';
  end if;
  v_sin := v_nom = '';
  if v_sin then v_nom := 'Sin nombre · ' || v_cod; end if;
  insert into public.muebles (codigo, nombre, tipo, categoria, material, medidas, color, descripcion, foto_catalogo, foto_real, mini, mini_v, qr)
  values (v_cod, v_nom, coalesce(p ->> 'tipo', ''), coalesce(p ->> 'categoria', ''), coalesce(p ->> 'material', ''), coalesce(p ->> 'medidas', ''),
          coalesce(p ->> 'color', ''), coalesce(p ->> 'descripcion', ''), nullif(p ->> 'foto_catalogo', ''), nullif(p ->> 'foto_real', ''),
          nullif(p ->> 'mini', ''), case when coalesce(p ->> 'mini', '') <> '' then extract(epoch from clock_timestamp())::bigint::text else '' end,
          case when coalesce(p ->> 'qrBase', '') <> '' then (p ->> 'qrBase') || '?mueble=' || v_cod else '' end);
  insert into public.lugares (codigo, ubic, dep, caja, cant)
  values (v_cod, p ->> 'ubic', coalesce(p ->> 'dep', ''), coalesce(p ->> 'caja', ''), jsonb_build_object(v_est, v_cant));
  perform public.acv_mov(p, v_cod, v_nom, 'Alta', v_cant, v_est, '', v_lug, '');
  v_fotos := concat_ws(' y ', case when coalesce(p ->> 'foto_catalogo', '') <> '' then 'foto de catálogo' end,
                              case when coalesce(p ->> 'foto_real', '') <> '' then 'foto real' end);
  perform public.acv_hist(p, v_cod, v_nom, 'Agregado', '', '',
    v_cant || ' u. ' || public.acv_en_estado(v_est) || ' · ' || v_lug ||
    (case when coalesce(p ->> 'categoria', '') <> '' then ' · ' || (p ->> 'categoria') else '' end) ||
    (case when coalesce(v_fotos, '') <> '' then ' · con ' || v_fotos else '' end));
  return jsonb_build_object('codigo', v_cod, 'mensaje',
    (case when v_sin then 'Se agregó ' || v_cod || ' (sin nombre por ahora: complétalo cuando puedas)'
          else '«' || v_nom || '» se agregó con el código ' || v_cod end) || ' (' || v_cant || ' u. en ' || v_lug || ').');
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
