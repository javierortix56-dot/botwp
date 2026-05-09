const axios = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept-Language': 'es-AR,es;q=0.9',
};

function parsearPrecio(texto) {
  if (!texto) return null;
  const num = parseFloat(texto.replace(/[^0-9,.]/g, '').replace(',', '.'));
  return isNaN(num) ? null : num;
}

async function buscarVtex(baseUrl, supermercado, producto, cantidad = 1) {
  try {
    const to = cantidad - 1;
    const url = `${baseUrl}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(producto)}&_from=0&_to=${to}`;
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Accept: 'application/json' },
      timeout: 12000,
    });
    if (!Array.isArray(data) || !data.length) return cantidad === 1 ? null : [];

    if (cantidad === 1) {
      const item = data[0];
      const oferta = item.items?.[0]?.sellers?.[0]?.commertialOffer;
      if (!oferta || !oferta.IsAvailable || !oferta.Price) return null;
      return {
        supermercado,
        nombre: item.productName,
        precio: oferta.Price,
        precioOriginal: oferta.ListPrice ?? oferta.Price,
        url: `${baseUrl}${item.link}`,
      };
    }

    // Modo múltiples resultados: aplanar todas las presentaciones
    const resultados = [];
    for (const producto of data) {
      for (const item of (producto.items || [])) {
        const oferta = item.sellers?.[0]?.commertialOffer;
        if (!oferta?.IsAvailable || !oferta?.Price) continue;
        resultados.push({
          supermercado,
          nombre: `${producto.productName} — ${item.name}`,
          precio: oferta.Price,
          precioOriginal: oferta.ListPrice ?? oferta.Price,
          tienePromo: (oferta.ListPrice ?? oferta.Price) > oferta.Price,
          url: `${baseUrl}${producto.link}`,
        });
      }
    }
    return resultados;
  } catch (err) {
    console.error(`[Precios] ${supermercado} error (${producto}):`, err.message);
    return cantidad === 1 ? null : [];
  }
}

async function buscarCarrefour(producto) {
  return buscarVtex('https://www.carrefour.com.ar', 'Carrefour', producto);
}

async function buscarJumbo(producto) {
  return buscarVtex('https://www.jumbo.com.ar', 'Jumbo', producto);
}

async function buscarCarrefourDetallado(query) {
  return buscarVtex('https://www.carrefour.com.ar', 'Carrefour', query, 5);
}

async function buscarJumboDetallado(query) {
  return buscarVtex('https://www.jumbo.com.ar', 'Jumbo', query, 5);
}

async function buscarCotoDetallado(query) {
  const dominios = ['www.cotodigital3.com.ar', 'www.cotodigital.com.ar'];
  for (const dominio of dominios) {
    try {
      const url = `https://${dominio}/sitios/cdigi/categoria?Ntt=${encodeURIComponent(query)}&No=0&Nrpp=5`;
      const { data } = await axios.get(url, {
        headers: { ...HEADERS, Accept: 'text/html' },
        timeout: 12000,
      });
      const $ = cheerio.load(data);
      console.log(`[Precios] Coto (${dominio}): title="${$('title').text().trim().slice(0, 60)}", .item_container=${$('.item_container').length}`);
      const resultados = [];

      $('.item_container').slice(0, 5).each((_, el) => {
        const contenedor = $(el);
        const nombre = contenedor.find('.descrip_full_name, .descrip_name').first().text().trim() || query;
        const precioTexto = contenedor.find('.precio_vigente span, .atg_store_newPrice span').first().text().trim();
        const precio = parsearPrecio(precioTexto);
        const originalTexto = contenedor.find('.precio_tachado span, .atg_store_oldPrice span').first().text().trim();
        const precioOriginal = parsearPrecio(originalTexto) || precio;

        if (precio) {
          resultados.push({
            supermercado: 'Coto',
            nombre,
            precio,
            precioOriginal,
            tienePromo: precioOriginal > precio,
            url,
          });
        }
      });

      if (resultados.length) return resultados;
    } catch (err) {
      console.error(`[Precios] Coto (${dominio}) error:`, err.message);
    }
  }
  return [];
}

function limpiarUrl(input) {
  try {
    // Jumbo: /slug/p
    const jumbo = input.match(/jumbo\.com\.ar\/([^/?#]+)\/p/);
    if (jumbo) return jumbo[1].replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    // Carrefour: /slug/p
    const carrefour = input.match(/carrefour\.com\.ar\/([^/?#]+)\/p/);
    if (carrefour) return carrefour[1].replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    // Cotodigital: /sitios/cdigi/productos/slug/_/codigo
    const coto = input.match(/cotodigital[^/]*\.com\.ar\/sitios\/cdigi\/productos\/([^/_]+)/);
    if (coto) return coto[1].replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {}
  return input;
}

async function buscarCotoPorUrlProducto(urlProducto) {
  try {
    const { data } = await axios.get(urlProducto, {
      headers: { ...HEADERS, Accept: 'text/html' },
      timeout: 12000,
    });
    const $ = cheerio.load(data);

    // Intentar JSON-LD (schema.org Product) — presente en HTML estático
    let precio = null;
    let precioOriginal = null;
    let nombre = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      if (precio) return;
      try {
        const json = JSON.parse($(el).text());
        const obj = json['@type'] === 'Product' ? json : (Array.isArray(json) ? json.find((x) => x['@type'] === 'Product') : null);
        if (!obj) return;
        nombre = obj.name || nombre;
        const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
        if (offer?.price) {
          precio = parseFloat(String(offer.price).replace(',', '.'));
          precioOriginal = parseFloat(String(offer.priceBeforeDiscount || offer.price).replace(',', '.'));
        }
      } catch {}
    });

    // Fallback: selectores CSS
    if (!precio) {
      const precioTexto = $('.atg_store_newPrice span, .precio_vigente span, .atg_store_newPrice, .precio_vigente').first().text().trim();
      precio = parsearPrecio(precioTexto);
      const originalTexto = $('.atg_store_oldPrice span, .precio_tachado span').first().text().trim();
      precioOriginal = parsearPrecio(originalTexto) || precio;
      nombre = nombre || $('h1, .atg_store_productTitle').first().text().trim();
    }

    if (!precio) {
      console.error(`[Precios] Coto URL directa: sin precio. HTML snippet: ${data.slice(0, 500)}`);
      return null;
    }

    return {
      supermercado: 'Coto',
      nombre: nombre || limpiarUrl(urlProducto),
      precio,
      precioOriginal: precioOriginal || precio,
      tienePromo: (precioOriginal || precio) > precio,
      url: urlProducto,
    };
  } catch (err) {
    console.error(`[Precios] Coto URL directa error:`, err.message);
    return null;
  }
}

async function buscarProductoDetallado(query) {
  const esCotoUrl = /cotodigital/i.test(query);
  const esUrl = /\.(com\.ar|com)\//i.test(query);
  const q = limpiarUrl(query);
  console.log(`[Precios] Búsqueda detallada: "${q}"${esCotoUrl ? ' (Coto URL directa)' : esUrl ? ' (URL)' : ''}`);

  // Si es URL específica, traer 1 resultado por super (el más relevante).
  // Si es búsqueda libre, traer 5 para mostrar todas las presentaciones.
  const cantidad = esUrl ? 1 : 5;
  const [carrefour, jumbo] = await Promise.all([
    buscarVtex('https://www.carrefour.com.ar', 'Carrefour', q, cantidad),
    buscarVtex('https://www.jumbo.com.ar', 'Jumbo', q, cantidad),
  ]);

  let coto;
  if (esCotoUrl) {
    const prod = await buscarCotoPorUrlProducto(query);
    coto = prod ? [prod] : [];
  } else {
    coto = await buscarCotoDetallado(q);
  }

  return { query: q, carrefour, jumbo, coto };
}

async function buscarCoto(producto) {
  try {
    const url = `https://www.cotodigital.com.ar/sitios/cdigi/categoria?Ntt=${encodeURIComponent(producto)}&No=0&Nrpp=1`;
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Accept: 'text/html' },
      timeout: 12000,
    });
    const $ = cheerio.load(data);

    const contenedor = $('.item_container').first();
    if (!contenedor.length) return null;

    const nombre = contenedor.find('.descrip_full_name, .descrip_name').first().text().trim() || producto;
    const precioTexto = contenedor.find('.precio_vigente span, .atg_store_newPrice span').first().text().trim();
    const precio = parsearPrecio(precioTexto);
    if (!precio) return null;

    const originalTexto = contenedor.find('.precio_tachado span, .atg_store_oldPrice span').first().text().trim();
    const precioOriginal = parsearPrecio(originalTexto) || precio;

    return {
      supermercado: 'Coto',
      nombre,
      precio,
      precioOriginal,
      url: `https://www.cotodigital.com.ar/sitios/cdigi/categoria?Ntt=${encodeURIComponent(producto)}`,
    };
  } catch (err) {
    console.error(`[Precios] Coto error (${producto}):`, err.message);
    return null;
  }
}

async function buscarProducto(producto) {
  const [carrefour, jumbo, coto] = await Promise.all([
    buscarCarrefour(producto),
    buscarJumbo(producto),
    buscarCoto(producto),
  ]);
  const resultados = [carrefour, jumbo, coto].filter(Boolean);
  return { producto, resultados };
}

async function buscarTodos(lista) {
  console.log(`[Precios] Buscando ${lista.length} productos en 3 supermercados...`);
  const resultados = [];

  // De a 4 productos en paralelo para no saturar
  for (let i = 0; i < lista.length; i += 4) {
    const lote = lista.slice(i, i + 4);
    const loteResultados = await Promise.all(lote.map(buscarProducto));
    resultados.push(...loteResultados);
    console.log(`[Precios] Lote ${Math.floor(i / 4) + 1} completado`);
  }

  return resultados;
}

async function buscarProductoConUrl(url) {
  const esCotoUrl = /cotodigital/i.test(url);
  const query = limpiarUrl(url);
  const [carrefour, jumbo] = await Promise.all([
    buscarCarrefour(query),
    buscarJumbo(query),
  ]);
  let coto;
  if (esCotoUrl) {
    coto = await buscarCotoPorUrlProducto(url);
  } else {
    coto = await buscarCoto(query);
  }
  const resultados = [carrefour, jumbo, coto].filter(Boolean);
  return { producto: query, resultados };
}

async function buscarDesdeUrls(urls) {
  console.log(`[Precios] Buscando ${urls.length} productos desde URLs...`);
  const resultados = [];
  for (let i = 0; i < urls.length; i += 4) {
    const lote = urls.slice(i, i + 4);
    const loteResultados = await Promise.all(lote.map(buscarProductoConUrl));
    resultados.push(...loteResultados);
  }
  return resultados;
}

module.exports = { buscarTodos, buscarProductoDetallado, buscarDesdeUrls };
