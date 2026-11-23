// Official Mr. Burger Menu Catalog & Price Calculation Engine (Empalme Branch)

export interface CatalogProduct {
  sku: string;
  name: string;
  aliases: string[];
  category: "hamburguesas" | "boneless_complementos" | "bebidas" | "postres";
  price_cents: number;
}

export interface CatalogModifier {
  sku: string;
  name: string;
  aliases: string[];
  category: "suplementos" | "extras" | "aderezos";
  price_cents: number;
}

export interface InputOrderItem {
  product?: string;
  name?: string;
  sku?: string;
  quantity?: number;
  modifiers?: Array<string | { name: string; price_cents?: number }>;
  notes?: string;
}

export interface ResolvedOrderItem {
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  modifiers_total_cents: number;
  item_total_cents: number;
  modifiers: string[];
  notes?: string;
}

export const CANONICAL_PRODUCTS: CatalogProduct[] = [
  // Hamburguesas (todas incluyen papas a la francesa)
  { sku: "BURGER-TOCINO", name: "Hamburguesa Tocino", aliases: ["tocino", "hamburguesa de tocino", "burger tocino"], category: "hamburguesas", price_cents: 13500 },
  { sku: "BURGER-FAVORITA", name: "Hamburguesa Favorita", aliases: ["favorita", "burger favorita"], category: "hamburguesas", price_cents: 13500 },
  { sku: "BURGER-CHICKEN", name: "Hamburguesa Chicken", aliases: ["chicken", "pollo", "hamburguesa de pollo"], category: "hamburguesas", price_cents: 14500 },
  { sku: "BURGER-CLASICA", name: "Hamburguesa Clásica", aliases: ["clasica", "burger clasica", "hamburguesa clasica"], category: "hamburguesas", price_cents: 12000 },
  { sku: "BURGER-CHEESE", name: "Cheeseburger", aliases: ["cheeseburger", "cheese burger", "hamburguesa con queso"], category: "hamburguesas", price_cents: 11000 },

  // Boneless y complementos
  { sku: "BONELESS-300G", name: "Boneless (300g)", aliases: ["boneless", "orden de boneless", "boneless 300g"], category: "boneless_complementos", price_cents: 16000 },
  { sku: "COMP-DEDOS-QUESO", name: "Dedos de queso", aliases: ["dedos de queso", "deditos de queso", "dedos queso"], category: "boneless_complementos", price_cents: 9500 },
  { sku: "COMP-AROS-CEBOLLA", name: "Aros de cebolla", aliases: ["aros de cebolla", "aros cebolla"], category: "boneless_complementos", price_cents: 9000 },
  { sku: "COMP-JALAPENOS", name: "Jalapeños rellenos", aliases: ["jalapenos rellenos", "jalapenos", "jalapeños rellenos", "jalapeños"], category: "boneless_complementos", price_cents: 9500 },
  { sku: "COMP-MR-PAPAS", name: "Mr. Papas", aliases: ["mr papas", "mr. papas", "mister papas"], category: "boneless_complementos", price_cents: 7500 },
  { sku: "COMP-PAPAS-SAZONADAS", name: "Papas sazonadas", aliases: ["papas sazonadas", "orden de papas sazonadas"], category: "boneless_complementos", price_cents: 8000 },
  { sku: "COMP-NUGGETS", name: "Nuggets", aliases: ["nuggets", "orden de nuggets", "nuggets con papas"], category: "boneless_complementos", price_cents: 8000 },
  { sku: "COMP-ENSALADA", name: "Ensalada", aliases: ["ensalada", "ensalada con pollo", "ensalada de pollo"], category: "boneless_complementos", price_cents: 15000 },
  { sku: "COMP-PAPAS-FRANCESAS", name: "Papas a la francesa", aliases: ["papas a la francesa", "papas francesas", "orden de papas francesas", "papas fritas"], category: "boneless_complementos", price_cents: 4000 },

  // Bebidas
  { sku: "BEB-LIM-MANGO", name: "Limonada de mango", aliases: ["limonada de mango", "limonada mango"], category: "bebidas", price_cents: 3000 },
  { sku: "BEB-LIM-FRUTOS-ROJOS", name: "Limonada de frutos rojos", aliases: ["limonada de frutos rojos", "limonada frutos rojos"], category: "bebidas", price_cents: 3000 },
  { sku: "BEB-AGUA-JAMAICA", name: "Agua de jamaica", aliases: ["agua de jamaica", "jamaica"], category: "bebidas", price_cents: 3000 },
  { sku: "BEB-LIM-FRESA", name: "Limonada de fresa", aliases: ["limonada de fresa", "limonada fresa"], category: "bebidas", price_cents: 3000 },
  { sku: "BEB-COCA-COLA", name: "Coca Cola", aliases: ["coca cola", "coca", "coca-cola", "refresco", "coke"], category: "bebidas", price_cents: 3000 },
  { sku: "BEB-JAZ-TEA", name: "Jaz Tea", aliases: ["jaz tea", "te jaz", "jaztea", "te"], category: "bebidas", price_cents: 3000 },
  { sku: "BEB-MALTEADA", name: "Malteada", aliases: ["malteada", "malteada de oreo", "malteada de vainilla", "malteada de fresa", "malteada de chocolate", "malteada oreo", "malteada chocolate"], category: "bebidas", price_cents: 7000 },

  // Postres
  { sku: "POST-3-LECHES", name: "Pastel 3 leches", aliases: ["pastel 3 leches", "tres leches", "pastel tres leches", "3 leches"], category: "postres", price_cents: 5000 },
  { sku: "POST-TRIPLE-CHOCO", name: "Triple chocolate", aliases: ["triple chocolate", "pastel de chocolate", "pastel triple chocolate"], category: "postres", price_cents: 5000 },
  { sku: "POST-CHEESECAKE", name: "Cheesecake", aliases: ["cheesecake", "pay de queso", "pastel cheesecake"], category: "postres", price_cents: 5000 }
];

export const CANONICAL_MODIFIERS: CatalogModifier[] = [
  // Suplementos por cambio de papas en hamburguesa
  { sku: "MOD-CAMBIO-SAZONADAS", name: "Cambio a papas sazonadas", aliases: ["cambio a papas sazonadas", "cambio papas sazonadas", "papas sazonadas cambio", "cambiar a papas sazonadas"], category: "suplementos", price_cents: 1500 },
  { sku: "MOD-CAMBIO-MR-PAPAS", name: "Cambio a Mr. Papas", aliases: ["cambio a mr papas", "cambio a mr. papas", "cambiar a mr papas", "cambio mr papas"], category: "suplementos", price_cents: 4000 },

  // Extras de ingredientes
  { sku: "MOD-EXTRA-CARNE-QUESO", name: "Carne y queso", aliases: ["carne y queso", "extra carne y queso", "doble carne y queso", "carne extra y queso"], category: "extras", price_cents: 4000 },
  { sku: "MOD-EXTRA-TOCINO", name: "Tocino (2 tiras)", aliases: ["tocino", "extra tocino", "tocino extra", "2 tiras de tocino", "tiras de tocino"], category: "extras", price_cents: 2500 },
  { sku: "MOD-EXTRA-QUESO-MENONITA", name: "Queso menonita", aliases: ["queso menonita", "extra queso menonita"], category: "extras", price_cents: 1000 },
  { sku: "MOD-EXTRA-QUESO-AMERICANO", name: "Queso americano", aliases: ["queso americano", "extra queso americano", "queso amarillo"], category: "extras", price_cents: 1000 },
  { sku: "MOD-EXTRA-AGUACATE", name: "Aguacate", aliases: ["aguacate", "extra aguacate"], category: "extras", price_cents: 2000 },
  { sku: "MOD-EXTRA-LECHUGA", name: "Lechuga", aliases: ["lechuga", "extra lechuga"], category: "extras", price_cents: 1000 },
  { sku: "MOD-EXTRA-TOMATE", name: "Tomate", aliases: ["tomate", "extra tomate"], category: "extras", price_cents: 1000 },
  { sku: "MOD-EXTRA-CEBOLLA-ASADA", name: "Cebolla asada", aliases: ["cebolla asada", "extra cebolla asada"], category: "extras", price_cents: 1000 },
  { sku: "MOD-EXTRA-CHILE-VERDE", name: "Chile verde", aliases: ["chile verde", "extra chile verde"], category: "extras", price_cents: 1500 },
  { sku: "MOD-EXTRA-CEBOLLA-CRISPY", name: "Cebolla crispy", aliases: ["cebolla crispy", "extra cebolla crispy"], category: "extras", price_cents: 1500 },

  // Aderezos adicionales ($15 c/u)
  { sku: "MOD-ADEREZO-BBQ", name: "Aderezo BBQ original", aliases: ["bbq", "bbq original", "aderezo bbq", "salsa bbq"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-BBQ-CHIPOTLE", name: "Aderezo BBQ chipotle", aliases: ["bbq chipotle", "aderezo bbq chipotle", "chipotle bbq"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-CHEDDAR", name: "Aderezo queso cheddar", aliases: ["queso cheddar", "aderezo cheddar", "cheddar", "aderezo de queso cheddar"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-RANCH", name: "Aderezo ranch de la casa", aliases: ["ranch", "ranch de la casa", "aderezo ranch"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-HONEY-MUSTARD", name: "Aderezo honey mustard", aliases: ["honey mustard", "aderezo honey mustard", "mostaza dulce"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-MISTER", name: "Aderezo mister", aliases: ["aderezo mister", "mister", "aderezo de la casa"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-RED-HOT", name: "Aderezo red hot", aliases: ["red hot", "aderezo red hot", "salsa red hot"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-MAYONESA", name: "Mayonesa", aliases: ["mayonesa", "extra mayonesa"], category: "aderezos", price_cents: 1500 },
  { sku: "MOD-ADEREZO-ITALIANA", name: "Salsa italiana", aliases: ["salsa italiana", "aderezo italiano"], category: "aderezos", price_cents: 1500 }
];

export function normalizeText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Searches for a matching product in DB items or canonical catalog
 */
export function findProduct(
  input: string,
  dbProducts: any[] = []
): { sku: string; name: string; price_cents: number } | null {
  const norm = normalizeText(input);
  if (!norm) return null;

  // 1. Try DB products if provided
  for (const p of dbProducts) {
    if (p.active === false) continue;
    const pSkuNorm = normalizeText(p.sku);
    const pNameNorm = normalizeText(p.name);
    if (pSkuNorm === norm || pNameNorm === norm) {
      return { sku: p.sku, name: p.name, price_cents: p.price_cents };
    }
  }

  // 2. Try canonical catalog
  for (const cp of CANONICAL_PRODUCTS) {
    const cpSkuNorm = normalizeText(cp.sku);
    const cpNameNorm = normalizeText(cp.name);
    if (cpSkuNorm === norm || cpNameNorm === norm) {
      return { sku: cp.sku, name: cp.name, price_cents: cp.price_cents };
    }
    for (const alias of cp.aliases) {
      if (normalizeText(alias) === norm) {
        return { sku: cp.sku, name: cp.name, price_cents: cp.price_cents };
      }
    }
  }

  // 3. Fallback partial/substring match for common terms (e.g. "clasica" in "hamburguesa clasica")
  for (const cp of CANONICAL_PRODUCTS) {
    const cpNameNorm = normalizeText(cp.name);
    if (norm.length >= 4 && (cpNameNorm.includes(norm) || norm.includes(cpNameNorm))) {
      return { sku: cp.sku, name: cp.name, price_cents: cp.price_cents };
    }
    for (const alias of cp.aliases) {
      const aNorm = normalizeText(alias);
      if (norm.length >= 4 && (aNorm.includes(norm) || norm.includes(aNorm))) {
        return { sku: cp.sku, name: cp.name, price_cents: cp.price_cents };
      }
    }
  }

  return null;
}

/**
 * Searches for a modifier/extra in DB or canonical list
 */
export function findModifier(
  input: string,
  dbModifiers: any[] = []
): { sku: string; name: string; price_cents: number; is_free: boolean } | null {
  const norm = normalizeText(input);
  if (!norm) return null;

  // Free preparation customization notes (do not add price)
  const freePatterns = [
    "sin cebolla",
    "sin pepinillo",
    "sin tomate",
    "sin lechuga",
    "sin aderezo",
    "sin salsa",
    "sin queso",
    "salsa aparte",
    "aderezo aparte",
    "bien cocida",
    "termino medio",
    "red hot",
    "mango habanero",
    "ajo parmesano",
    "pelon rico",
    "vainilla",
    "chocolate",
    "fresa",
    "oreo"
  ];
  if (freePatterns.some(fp => norm.includes(fp) || fp.includes(norm))) {
    return { sku: "CUSTOM-NOTE", name: input, price_cents: 0, is_free: true };
  }

  // 1. Try DB modifiers if provided
  for (const m of dbModifiers) {
    const mSkuNorm = normalizeText(m.sku);
    const mNameNorm = normalizeText(m.name);
    if (mSkuNorm === norm || mNameNorm === norm) {
      return { sku: m.sku, name: m.name, price_cents: m.price_cents, is_free: false };
    }
  }

  // 2. Try canonical modifiers
  for (const cm of CANONICAL_MODIFIERS) {
    const cmSkuNorm = normalizeText(cm.sku);
    const cmNameNorm = normalizeText(cm.name);
    if (cmSkuNorm === norm || cmNameNorm === norm) {
      return { sku: cm.sku, name: cm.name, price_cents: cm.price_cents, is_free: false };
    }
    for (const alias of cm.aliases) {
      const aNorm = normalizeText(alias);
      if (aNorm === norm || (norm.length >= 5 && (aNorm.includes(norm) || norm.includes(aNorm)))) {
        return { sku: cm.sku, name: cm.name, price_cents: cm.price_cents, is_free: false };
      }
    }
  }

  return null;
}

export function validateAndPriceOrder(
  rawItems: any[],
  fulfillment: "pickup" | "delivery",
  dbProducts: any[] = [],
  dbModifiers: any[] = []
): {
  items: ResolvedOrderItem[];
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  total_formatted: string;
} {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("El pedido debe contener al menos un producto");
  }

  const resolvedItems: ResolvedOrderItem[] = [];
  let subtotalCents = 0;

  for (const raw of rawItems) {
    const rawName = String(raw.product || raw.name || raw.sku || "").trim();
    if (!rawName) {
      throw new Error("Nombre de producto no especificado");
    }

    const matchedProduct = findProduct(rawName, dbProducts);
    if (!matchedProduct) {
      throw new Error(`Producto no reconocido en el menú: ${rawName}`);
    }

    const qty = Number(raw.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
      throw new Error(`Cantidad inválida para el producto: ${rawName}`);
    }

    // Process modifiers
    const rawMods: any[] = Array.isArray(raw.modifiers)
      ? raw.modifiers
      : Array.isArray(raw.modifications)
      ? raw.modifications
      : Array.isArray(raw.options)
      ? raw.options
      : [];

    let modsTotalCents = 0;
    const finalModifiers: string[] = [];

    for (const mod of rawMods) {
      const modName = typeof mod === "string" ? mod.trim() : String(mod?.name || "").trim();
      if (!modName) continue;

      const matchedMod = findModifier(modName, dbModifiers);
      if (!matchedMod) {
        throw new Error(`Modificador no reconocido: ${modName}`);
      }
      modsTotalCents += matchedMod.price_cents;
      finalModifiers.push(matchedMod.name);
    }

    const itemTotalCents = (matchedProduct.price_cents + modsTotalCents) * qty;
    subtotalCents += itemTotalCents;

    resolvedItems.push({
      sku: matchedProduct.sku,
      name: matchedProduct.name,
      quantity: qty,
      unit_price_cents: matchedProduct.price_cents,
      modifiers_total_cents: modsTotalCents,
      item_total_cents: itemTotalCents,
      modifiers: finalModifiers,
      ...(raw.notes ? { notes: String(raw.notes).trim() } : {})
    });
  }

  // Shipping cost: $40 MXN for delivery, $0 for pickup
  const shippingCents = fulfillment === "delivery" ? 4000 : 0;
  const totalCents = subtotalCents + shippingCents;
  const totalFormatted = `$${Math.round(totalCents / 100)}`;

  return {
    items: resolvedItems,
    subtotal_cents: subtotalCents,
    shipping_cents: shippingCents,
    total_cents: totalCents,
    total_formatted: totalFormatted
  };
}
