/**
 * ██████████████████████████████████████████████████████████████████████
 * █  EXPLORADOR DE LICITACIONES — SENERCOM                              █
 * █  Backend Apps Script — proxy hacia api.mercadopublico.cl            █
 * █  El ticket NUNCA va en este archivo. Va aparte, en el editor.       █
 * ██████████████████████████████████████████████████████████████████████
 *
 * 🔑 PASO 1 — Pegar tus claves (NO en este archivo, sino en el editor):
 *    Apps Script (script.google.com) > ⚙️ Configuración del proyecto
 *    > Propiedades del script > Agregar propiedad de script
 *
 *    ┌─────────────────────┬──────────────────────────────────────────┐
 *    │ MP_TICKET            │ tu ticket de api.mercadopublico.cl       │
 *    │                      │ (pedido en api.mercadopublico.cl/        │
 *    │                      │  modules/IniciarSesion.aspx)             │
 *    ├─────────────────────┼──────────────────────────────────────────┤
 *    │ CLAVE_APP            │ una clave que tú inventes, para que solo │
 *    │                      │ tu PWA pueda usar este backend           │
 *    ├─────────────────────┼──────────────────────────────────────────┤
 *    │ RESUMEN_DESTINATARIO │ contacto@senercom.cl (opcional, ya es    │
 *    │                      │ el valor por defecto si no la agregas)   │
 *    ├─────────────────────┼──────────────────────────────────────────┤
 *    │ RESUMEN_ESTADOS      │ publicada,adjudicada (opcional)          │
 *    ├─────────────────────┼──────────────────────────────────────────┤
 *    │ RESUMEN_KEYWORDS     │ tus palabras clave separadas por coma    │
 *    │                      │ (opcional; ya trae tu lista real como    │
 *    │                      │ valor por defecto en el código)          │
 *    ├─────────────────────┼──────────────────────────────────────────┤
 *    │ RESUMEN_DIAS_ATRAS   │ 7 (opcional)                             │
 *    └─────────────────────┴──────────────────────────────────────────┘
 *
 * 🚀 PASO 2 — Desplegar como Web App:
 *    Implementar > Nueva implementación > Aplicación web
 *    Ejecutar como: Yo (carlos.braun@gmail.com — NUNCA cbraun@senercom.cl, por CORS)
 *    Quién tiene acceso: Cualquier usuario
 *    → copia la URL resultante y pégala en APPS_SCRIPT_URL dentro de index.html
 *
 * ⏰ PASO 3 — Activar el resumen diario por correo (una sola vez):
 *    Selecciona "configurarTriggerDiario" en el menú desplegable de arriba
 *    y presiona ▶ Ejecutar. Acepta los permisos que te pida.
 */

const MP_BASE = 'https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json';

// Mapeo de nombre visible -> nombre que usa la API para filtrar por estado
const ESTADOS_VALIDOS = ['publicada', 'cerrada', 'desierta', 'adjudicada', 'revocada', 'suspendida'];

// El listado diario (por fecha) NO trae un campo de texto "Estado": trae
// "CodigoEstado" numérico. Solo la ficha detallada (por código) trae el
// texto. Por eso hay que traducir el código acá para poder filtrar.
const CODIGO_A_ESTADO = {
  '5': 'Publicada',
  '6': 'Cerrada',
  '7': 'Desierta',
  '8': 'Adjudicada',
  '18': 'Revocada',
  '19': 'Suspendida'
};

function textoEstado(lic) {
  return CODIGO_A_ESTADO[String(lic.CodigoEstado)] || lic.Estado || 'Desconocido';
}

// Chile no tiene servicio de "región" en el listado básico de la API, así que
// la región/comuna se obtiene desde la ficha detallada (BuscarComprador/Comprador)
// de cada licitación que YA matcheó el filtro — no se pide para todo el listado.

function doGet(e) {
  const callback = e.parameter.callback || 'callback';
  try {
    const resultado = procesarSolicitud(e.parameter);
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(resultado) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  } catch (err) {
    const errorPayload = { ok: false, error: String(err && err.message ? err.message : err) };
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(errorPayload) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
}

function procesarSolicitud(params) {
  const props = PropertiesService.getScriptProperties();
  const CLAVE_APP = props.getProperty('CLAVE_APP');
  const MP_TICKET = props.getProperty('MP_TICKET');

  if (!MP_TICKET) {
    return { ok: false, error: 'Falta configurar MP_TICKET en las Propiedades del script.' };
  }
  if (CLAVE_APP && params.claveApp !== CLAVE_APP) {
    return { ok: false, error: 'Clave de acceso inválida.' };
  }

  const fechaDesde = parseFechaDDMMAAAA(params.fechaDesde);
  const fechaHasta = parseFechaDDMMAAAA(params.fechaHasta);
  if (!fechaDesde || !fechaHasta) {
    return { ok: false, error: 'fechaDesde y fechaHasta son obligatorias (formato dd-mm-aaaa).' };
  }

  const diasTotales = Math.round((fechaHasta - fechaDesde) / 86400000) + 1;
  if (diasTotales < 1 || diasTotales > 92) {
    return { ok: false, error: 'El rango de fechas debe ser entre 1 y 92 días.' };
  }

  const estados = (params.estados || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return ESTADOS_VALIDOS.indexOf(s) !== -1; });

  const keywords = (params.keywords || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  const resultado = buscarLicitaciones(fechaDesde, fechaHasta, estados, keywords, MP_TICKET);
  return Object.assign({ ok: true }, resultado);
}

// Motor de búsqueda compartido: lo usan tanto el dashboard (doGet) como el
// resumen diario por correo. fechaDesde/fechaHasta son objetos Date.
//
// Hace las llamadas a la API EN PARALELO (por tandas, con fetchAll) en vez
// de una por una — con rangos largos, uno por uno podía demorar minutos.
const MAX_DETALLES_POR_BUSQUEDA = 300; // tope de seguridad para no colgar la búsqueda
const TAMANO_TANDA = 40; // cuántas peticiones en paralelo por tanda

function buscarLicitaciones(fechaDesde, fechaHasta, estados, keywords, MP_TICKET) {
  const fechas = [];
  for (let d = new Date(fechaDesde); d <= fechaHasta; d.setDate(d.getDate() + 1)) {
    fechas.push(formatearFechaAPI(d));
  }

  const listadosPorDia = obtenerListadosDias(fechas, MP_TICKET);
  const erroresDias = fechas.filter(function (f) { return !listadosPorDia[f] || !listadosPorDia[f].ok; });

  const candidatos = [];
  fechas.forEach(function (fechaStr) {
    const entrada = listadosPorDia[fechaStr];
    if (!entrada || !entrada.ok) return;

    entrada.listado.forEach(function (lic) {
      const estadoTexto = textoEstado(lic);
      const estadoLic = estadoTexto.toLowerCase();
      if (estados.length && estados.indexOf(estadoLic) === -1) return;

      const nombreLic = lic.Nombre || '';
      const textoBusqueda = (nombreLic + ' ' + (lic.CodigoExterno || '')).toLowerCase();
      const matches = keywords.filter(function (k) {
        return textoBusqueda.indexOf(k.toLowerCase()) !== -1;
      });
      if (keywords.length && matches.length === 0) return;

      candidatos.push({
        codigo: lic.CodigoExterno,
        nombre: nombreLic,
        estado: estadoTexto,
        fechaCierre: lic.FechaCierre || null,
        matches: matches,
        matchCount: matches.length
      });
    });
  });

  // Deduplicar por código (una licitación puede aparecer más de un día si se
  // vuelve a consultar el mismo rango)
  const vistos = {};
  let unicos = candidatos.filter(function (c) {
    if (vistos[c.codigo]) return false;
    vistos[c.codigo] = true;
    return true;
  });

  // Tope de seguridad: si hay demasiados matches (rango muy amplio + filtro
  // muy abierto), no intentamos pedir la ficha detallada de todos — eso es
  // lo que colgaba la búsqueda. Se avisa en la respuesta si se truncó.
  const truncado = unicos.length > MAX_DETALLES_POR_BUSQUEDA;
  if (truncado) {
    unicos.sort(function (a, b) { return (b.fechaCierre || '').localeCompare(a.fechaCierre || ''); });
    unicos = unicos.slice(0, MAX_DETALLES_POR_BUSQUEDA);
  }

  const detallesPorCodigo = obtenerDetalles(unicos.map(function (c) { return c.codigo; }), MP_TICKET);
  const resultados = unicos.map(function (c) {
    return enriquecerConDetalle(c, detallesPorCodigo[c.codigo]);
  });

  resultados.sort(function (a, b) {
    return (b.fechaCierre || '').localeCompare(a.fechaCierre || '');
  });

  return {
    total: resultados.length,
    erroresDias: erroresDias,
    truncado: truncado,
    resultados: resultados
  };
}

function partirEnTandas(arr, tamano) {
  const tandas = [];
  for (let i = 0; i < arr.length; i += tamano) tandas.push(arr.slice(i, i + tamano));
  return tandas;
}

// Trae el listado de varios días de una vez, en paralelo por tandas.
// Devuelve un mapa { fechaStr: { ok, listado } }.
function obtenerListadosDias(fechas, ticket) {
  const cache = CacheService.getScriptCache();
  const resultado = {};
  const pendientes = [];

  fechas.forEach(function (fechaStr) {
    const cacheado = cache.get('dia_' + fechaStr);
    if (cacheado) {
      resultado[fechaStr] = { ok: true, listado: JSON.parse(cacheado) };
    } else {
      pendientes.push({
        fechaStr: fechaStr,
        url: MP_BASE + '?fecha=' + fechaStr + '&estado=todos&ticket=' + encodeURIComponent(ticket)
      });
    }
  });

  partirEnTandas(pendientes, TAMANO_TANDA).forEach(function (tanda) {
    const respuestas = UrlFetchApp.fetchAll(tanda.map(function (p) { return { url: p.url, muteHttpExceptions: true }; }));
    respuestas.forEach(function (resp, i) {
      const p = tanda[i];
      try {
        if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
        const listado = JSON.parse(resp.getContentText()).Listado || [];
        resultado[p.fechaStr] = { ok: true, listado: listado };
        try { cache.put('dia_' + p.fechaStr, JSON.stringify(listado), 21600); } catch (e) { /* payload muy grande */ }
      } catch (err) {
        resultado[p.fechaStr] = { ok: false, listado: [] };
      }
    });
  });

  return resultado;
}

// Trae la ficha detallada de varios códigos de una vez, en paralelo por
// tandas. Devuelve un mapa { codigo: detalle | null }.
function obtenerDetalles(codigos, ticket) {
  const cache = CacheService.getScriptCache();
  const resultado = {};
  const pendientes = [];

  codigos.forEach(function (codigo) {
    const cacheado = cache.get('lic_' + codigo);
    if (cacheado) {
      resultado[codigo] = JSON.parse(cacheado);
    } else {
      pendientes.push({
        codigo: codigo,
        url: MP_BASE + '?codigo=' + encodeURIComponent(codigo) + '&ticket=' + encodeURIComponent(ticket)
      });
    }
  });

  partirEnTandas(pendientes, TAMANO_TANDA).forEach(function (tanda) {
    const respuestas = UrlFetchApp.fetchAll(tanda.map(function (p) { return { url: p.url, muteHttpExceptions: true }; }));
    respuestas.forEach(function (resp, i) {
      const p = tanda[i];
      let detalle = null;
      try {
        if (resp.getResponseCode() === 200) {
          const data = JSON.parse(resp.getContentText());
          detalle = (data.Listado && data.Listado[0]) || null;
        }
      } catch (err) {
        detalle = null;
      }
      resultado[p.codigo] = detalle;
      if (detalle) {
        try { cache.put('lic_' + p.codigo, JSON.stringify(detalle), 21600); } catch (e) { /* ignorar */ }
      }
    });
  });

  return resultado;
}

function enriquecerConDetalle(candidato, detalle) {
  const comprador = (detalle && detalle.Comprador) || {};
  const descripcion = (detalle && detalle.Descripcion) || '';
  const montoPublicado = detalle && detalle.MontoEstimado;
  const monedaPublicada = detalle && detalle.Moneda;
  const visibilidadMonto = detalle ? detalle.VisibilidadMonto : null;

  let monto = { valor: null, moneda: null, fuente: 'no_disponible' };

  if (montoPublicado && Number(montoPublicado) > 0 && visibilidadMonto !== 0 && visibilidadMonto !== '0') {
    monto = { valor: Number(montoPublicado), moneda: monedaPublicada || 'CLP', fuente: 'publicado' };
  } else {
    const extraido = extraerMontoDeTexto(descripcion);
    if (extraido) {
      monto = { valor: extraido.valor, moneda: extraido.moneda, fuente: 'descripcion' };
    }
  }

  return {
    codigo: candidato.codigo,
    nombre: candidato.nombre,
    estado: candidato.estado,
    fechaCierre: candidato.fechaCierre,
    matches: candidato.matches,
    matchCount: candidato.matchCount,
    organismo: comprador.NombreOrganismo || null,
    region: comprador.RegionUnidad || null,
    comuna: comprador.ComunaUnidad || null,
    monto: monto,
    urlLicitacion: 'https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idLicitacion=' + encodeURIComponent(candidato.codigo)
  };
}

// Busca menciones de monto dentro de la descripción cuando ChileCompra no
// publicó el MontoEstimado. Cubre los formatos más comunes: $, M$, UF, UTM.
function extraerMontoDeTexto(texto) {
  if (!texto) return null;

  const patrones = [
    { re: /UF\s?\$?\s?([\d.,]+)/i, moneda: 'CLF' },
    { re: /UTM\s?\$?\s?([\d.,]+)/i, moneda: 'UTM' },
    { re: /M\$\s?([\d.,]+)/i, moneda: 'CLP_MILES' },
    { re: /\$\s?([\d.,]+)/i, moneda: 'CLP' }
  ];

  for (let i = 0; i < patrones.length; i++) {
    const m = texto.match(patrones[i].re);
    if (m) {
      const numero = Number(m[1].replace(/\./g, '').replace(',', '.'));
      if (!isNaN(numero) && numero > 0) {
        return { valor: numero, moneda: patrones[i].moneda };
      }
    }
  }
  return null;
}

function parseFechaDDMMAAAA(str) {
  if (!str) return null;
  const partes = str.split('-');
  if (partes.length !== 3) return null;
  const d = new Date(Number(partes[2]), Number(partes[1]) - 1, Number(partes[0]));
  return isNaN(d.getTime()) ? null : d;
}

function formatearFechaAPI(date) {
  const dd = ('0' + date.getDate()).slice(-2);
  const mm = ('0' + (date.getMonth() + 1)).slice(-2);
  const yyyy = date.getFullYear();
  return dd + mm + yyyy;
}

/* ============================================================
 * RESUMEN DIARIO POR CORREO
 * ============================================================
 * Se ejecuta sola todos los días vía un trigger de tiempo (ver
 * configurarTriggerDiario más abajo). Busca lo publicado ese día
 * con tus filtros por defecto, arma un Excel y lo manda por correo.
 *
 * Propiedades del script que usa (todas opcionales salvo MP_TICKET):
 *   RESUMEN_DESTINATARIO = contacto@senercom.cl        (por defecto)
 *   RESUMEN_ESTADOS      = publicada,adjudicada         (por defecto)
 *   RESUMEN_KEYWORDS     = eléctrica,alumbrado,CCTV,... (por defecto: tu lista real, ya en el código)
 *   RESUMEN_DIAS_ATRAS   = 7  (cuántos días hacia atrás mirar)
 * ============================================================ */

function enviarResumenDiario() {
  const props = PropertiesService.getScriptProperties();
  const MP_TICKET = props.getProperty('MP_TICKET');
  if (!MP_TICKET) { throw new Error('Falta MP_TICKET en las Propiedades del script.'); }

  const destinatario = props.getProperty('RESUMEN_DESTINATARIO') || 'contacto@senercom.cl';
  const estados = (props.getProperty('RESUMEN_ESTADOS') || 'publicada,adjudicada')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  const keywords = (props.getProperty('RESUMEN_KEYWORDS') ||
    'eléctrica,eléctrico,electricidad,generador,subestación,malla a tierra,red de distribución,baja tensión,media tensión,mantenimiento eléctrico,proyecto eléctrico,tablero eléctrico,iluminación,alumbrado,sistema eléctrico,instalación eléctrica,CCTV,cámaras de seguridad,control de acceso,incendio,videovigilancia,televigilancia,telefonía IP,puntos de cámaras,red de datos,red de voz,sistema de seguridad,alarma,certificación de puntos de datos')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const diasAtras = Number(props.getProperty('RESUMEN_DIAS_ATRAS') || '7');

  const hoy = new Date();
  const fechaDesde = new Date(hoy);
  fechaDesde.setDate(fechaDesde.getDate() - (diasAtras - 1));

  const resultado = buscarLicitaciones(fechaDesde, hoy, estados, keywords, MP_TICKET);

  const nombreArchivo = 'Resumen licitaciones SENERCOM - ' + Utilities.formatDate(hoy, 'America/Santiago', 'dd-MM-yyyy');
  const blobExcel = construirExcel(resultado.resultados, nombreArchivo);

  const asunto = resultado.total > 0
    ? '📋 ' + resultado.total + ' licitación(es) — ' + Utilities.formatDate(hoy, 'America/Santiago', 'dd-MM-yyyy')
    : 'Sin licitaciones nuevas — ' + Utilities.formatDate(hoy, 'America/Santiago', 'dd-MM-yyyy');

  let cuerpo = 'Resumen automático del Explorador de Licitaciones SENERCOM.\n\n' +
    'Licitaciones encontradas: ' + resultado.total + '\n' +
    'Rango consultado: ' + Utilities.formatDate(fechaDesde, 'America/Santiago', 'dd-MM-yyyy') + ' a ' + Utilities.formatDate(hoy, 'America/Santiago', 'dd-MM-yyyy') + '\n' +
    'Estados: ' + (estados.join(', ') || 'todos') + '\n' +
    'Palabras clave: ' + (keywords.join(', ') || '(sin filtro, todas las licitaciones del rango)') + '\n\n' +
    'Se adjunta el detalle en Excel — puedes filtrar y ordenar por cualquier columna ahí.';

  if (resultado.erroresDias.length) {
    cuerpo += '\n\n⚠️ Advertencia: ' + resultado.erroresDias.length + ' día(s) no pudieron consultarse en Mercado Público. El resumen puede estar incompleto.';
  }

  MailApp.sendEmail({
    to: destinatario,
    subject: asunto,
    body: cuerpo,
    attachments: [blobExcel],
    name: 'Explorador de Licitaciones SENERCOM'
  });
}

// Arma un Google Sheet temporal con los resultados, lo exporta como .xlsx
// y borra el Sheet temporal. Devuelve el blob del Excel listo para adjuntar.
function construirExcel(resultados, nombreArchivo) {
  const ss = SpreadsheetApp.create(nombreArchivo);
  const hoja = ss.getSheets()[0];

  const encabezados = [
    'Código', 'Nombre', 'Estado', 'Organismo', 'Región', 'Comuna',
    'Monto', 'Moneda', 'Fuente del monto', 'Fecha de cierre', 'Palabras clave', 'Link'
  ];
  hoja.appendRow(encabezados);

  resultados.forEach(function (r) {
    hoja.appendRow([
      r.codigo,
      r.nombre,
      r.estado,
      r.organismo || '',
      r.region || '',
      r.comuna || '',
      r.monto && r.monto.valor != null ? r.monto.valor : '',
      r.monto ? r.monto.moneda || '' : '',
      r.monto ? r.monto.fuente : '',
      r.fechaCierre ? r.fechaCierre.split('T')[0] : '',
      (r.matches || []).join(', '),
      r.urlLicitacion
    ]);
  });

  // Encabezado en negrita, fila fija y autofiltro para que se pueda filtrar
  // y ordenar directo en Excel, tal como pediste.
  const rangoTotal = hoja.getRange(1, 1, Math.max(resultados.length + 1, 1), encabezados.length);
  hoja.getRange(1, 1, 1, encabezados.length).setFontWeight('bold').setBackground('#003B49').setFontColor('#ffffff');
  hoja.setFrozenRows(1);
  if (resultados.length > 0) { rangoTotal.createFilter(); }
  hoja.autoResizeColumns(1, encabezados.length);
  SpreadsheetApp.flush();

  const fileId = ss.getId();
  const url = 'https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=xlsx';
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  const blob = resp.getBlob().setName(nombreArchivo + '.xlsx');

  DriveApp.getFileById(fileId).setTrashed(true); // no dejar el Sheet temporal dando vueltas

  return blob;
}

// Ejecuta esto UNA SOLA VEZ manualmente desde el editor (▶ Ejecutar) para
// instalar el disparador diario. Si lo corres de nuevo, reemplaza el anterior
// en vez de duplicarlo.
function configurarTriggerDiario() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'enviarResumenDiario') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('enviarResumenDiario')
    .timeBased()
    .everyDays(1)
    .atHour(8) // se ejecuta entre las 8:00 y las 9:00 (hora del huso del proyecto)
    .create();
}

// 🔍 DIAGNÓSTICO — ejecuta esta función manualmente (▶ Ejecutar) y después
// revisa el ícono de reloj ⏰ > Registro de ejecución para ver exactamente
// qué respondió la API de Mercado Público. Bórrala cuando ya no la necesites.
function diagnosticoTicket() {
  const MP_TICKET = PropertiesService.getScriptProperties().getProperty('MP_TICKET');
  Logger.log('MP_TICKET leído (largo): ' + (MP_TICKET ? MP_TICKET.length + ' caracteres' : 'NO ESTÁ CONFIGURADO'));

  const hoy = new Date();
  const fechaStr = formatearFechaAPI(hoy);
  const url = MP_BASE + '?fecha=' + fechaStr + '&estado=todos&ticket=' + encodeURIComponent(MP_TICKET || '');

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Código HTTP: ' + resp.getResponseCode());
  Logger.log('Respuesta cruda (primeros 1000 caracteres): ' + resp.getContentText().substring(0, 1000));
}
