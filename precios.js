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

    const resultados = [];
    for (const prod of data) {
      for (const item of (prod.items || [])) {
        const oferta = item.sellers?.[0]?.commertialOffer;
        if (!oferta?.IsAvailable || !oferta?.Price) continue;
        resultados.push({
          supermercado,
          nombre: `${prod.productName} — ${item.name}`,
          precio: oferta.Price,
          precioOriginal: oferta.ListPrice ?? oferta.Price,
          tienePromo: (oferta.ListPrice ?? oferta.Price) > oferta.Price,
          url: `${baseUrl}${prod.link}`,
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
  try {
    const url = `https://www.coto.com.ar/busqueda/index.aspx?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Accept: 'text/html' },
      timeout: 12000,
    });
    const $ = cheerio.load(data);
    const resultados = [];

    $('.product-item, .item-product, .product-list-item').slice(0, 5).each((_, el) => {
      const contenedor = $(el);
      let nombre = null;
      let precio = null;

      for (const sel of ['.product-item-name', '.description', '.product-name', 'h2.name', '.item-title']) {
        const txt = contenedor.find(sel).first().text().trim();
        if (txt) { nombre = txt; break; }
      }
      for (const sel of ['.product-item-price', '.price', '.selling-price', '.product-price', '.item-price']) {
        const txt = contenedor.find(sel).first().text().trim();
        const p = parsearPrecio(txt);
        if (p) { precio = p; break; }
      }

      if (precio) {
        resultados.push({
          supermercado: 'Coto',
          nombre: nombre || query,
          precio,
          precioOriginal: precio,
          tienePromo: false,
          url,
        });
      }
    });
    return resultados;
  } catch (err) {
    console.error(`[Precios] Coto detallado error (${query}):`, err.message);
    return [];
  }
}

async function buscarCoto(producto) {
  try {
    const url = `https://www.coto.com.ar/busqueda/index.aspx?q=${encodeURIComponent(producto)}`;
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Accept: 'text/html' },
      timeout: 12000,
    });
    const $ = cheerio.load(data);

    const contenedor = $('.product-item, .item-product, .product-list-item').first();
    if (!contenedor.length) return null;

    let nombre = null;
    let precio = null;

    for (const sel of ['.product-item-name', '.description', '.product-name', 'h2.name', '.item-title']) {
      const txt = contenedor.find(sel).first().text().trim();
      if (txt) { nombre = txt; break; }
    }
    for (const sel of ['.product-item-price', '.price', '.selling-price', '.product-price', '.item-price']) {
      const txt = contenedor.find(sel).first().text().trim();
      const p = parsearPrecio(txt);
      if (p) { precio = p; break; }
    }

    if (!precio) return null;
    return { supermercado: 'Coto', nombre: nombre || producto, precio, precioOriginal: precio, url };
  } catch (err) {
    console.error(`[Precios] Coto error (${producto}):`, err.message);
    return null;
  }
}

function limpiarUrlJumbo(input) {
  try {
    const match = input.match(/jumbo\.com\.ar\/([^/]+)\/p/);
    if (match) return match[1].replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {}
  return input;
}

async function buscarProductoDetallado(query) {
  const q = limpiarUrlJumbo(query);
  console.log(`[Precios] Búsqueda detallada: "${q}"`);
  const [carrefour, jumbo, coto] = await Promise.all([
    buscarCarrefourDetallado(q),
    buscarJumboDetallado(q),
    buscarCotoDetallado(q),
  ]);
  return { query: q, carrefour, jumbo, coto };
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
  for (let i = 0; i < lista.length; i += 4) {
    const lote = lista.slice(i, i + 4);
    const loteResultados = await Promise.all(lote.map(buscarProducto));
    resultados.push(...loteResultados);
    console.log(`[Precios] Lote ${Math.floor(i / 4) + 1} completado`);
  }
  return resultados;
}

module.exports = { buscarTodos, buscarProductoDetallado };
