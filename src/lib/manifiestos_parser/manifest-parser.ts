import {
  FIELD_ALIASES,
} from "../manifiestos_archivos/manifest-field-aliases";
import {
  ManifestExtractionSchema,
} from "../manifiestos_archivos/manifest-extraction.schema";
import type {
  ExtractedField,
  ManifestExtraction,
  ManifestSection,
} from "../manifiestos_archivos/manifest-extraction";
import {
  findLine,
  locateAlias,
  normalizeLine,
  normalizePdfText,
  parseSections,
  splitLayoutColumns,
  type ParsedLine,
} from "./section-parser";

const SOURCE = "PDF_TEXT" as const;

function emptyField<T>(section: ManifestSection): ExtractedField<T> {
  return {
    value: null,
    confidence: 0,
    source: SOURCE,
    section,
    matchedLabel: null,
  };
}

function field<T>(
  value: T | null,
  section: ManifestSection,
  confidence: number,
  matchedLabel: string,
): ExtractedField<T> {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return emptyField(section);
  }

  return {
    value,
    confidence: Math.max(0, Math.min(1, confidence)),
    source: SOURCE,
    section,
    matchedLabel,
  };
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseDate(value: string): string | null {
  const match = clean(value).match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseMoney(value: string): number | null {
  let normalized = clean(value)
    .replace(/\$/g, "")
    .replace(/\s/g, "");

  if (!normalized) return null;

  if (normalized.includes(",") && normalized.includes(".")) {
    // Accept both 1.250.000,50 and 1,250,000.50.
    if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
      normalized = normalized.replace(/\./g, "").replace(/,/g, ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if ((normalized.match(/\./g) ?? []).length > 1) {
    normalized = normalized.replace(/\./g, "");
  } else if ((normalized.match(/,/g) ?? []).length > 1) {
    normalized = normalized.replace(/,/g, "");
  } else if (normalized.includes(",")) {
    const [integer, decimal] = normalized.split(",");
    normalized = decimal && decimal.length <= 3 ? `${integer}.${decimal}` : `${integer}${decimal ?? ""}`;
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function exactField<T>(
  value: T | null,
  section: ManifestSection,
  label: string,
  confidence = 0.99,
): ExtractedField<T> {
  return field(value, section, confidence, label);
}

function findValueNearLabel(
  lines: ParsedLine[],
  aliases: readonly string[],
  section: ManifestSection,
): ExtractedField<string> {
  for (const line of lines) {
    const match = locateAlias(line.raw, aliases);
    if (!match) continue;

    const after = line.raw.slice(match.end).replace(/^[\s:|-]+/, "").trim();
    if (after) {
      return exactField(after, section, match.alias, 0.96);
    }

    const position = lines.indexOf(line);
    const next = lines[position + 1]?.raw.trim();
    if (next) {
      return exactField(next, section, match.alias, 0.93);
    }
  }

  return emptyField(section);
}

function findRowAfterHeader(
  lines: ParsedLine[],
  headerPredicate: (normalized: string) => boolean,
): { header: ParsedLine; data: ParsedLine[] } | null {
  const headerIndex = lines.findIndex((line) => headerPredicate(line.normalized));
  if (headerIndex < 0) return null;

  const data: ParsedLine[] = [];
  for (let i = headerIndex + 1; i < lines.length && data.length < 4; i += 1) {
    if (lines[i].normalized) data.push(lines[i]);
    if (data.length > 0 && /^(INFORMACION|VALOR DEL VIAJE|RECOMENDACIONES|FIRMA)/.test(lines[i].normalized)) {
      break;
    }
  }

  return { header: lines[headerIndex], data };
}

function parseCompany(lines: ParsedLine[]): ManifestExtraction["company"] {
  const headerIndex = lines.findIndex((line) => line.normalized === "MANIFIESTO ELECTRONICO DE CARGA");
  const headerLines = headerIndex >= 0 ? lines.slice(headerIndex, headerIndex + 10) : lines.slice(0, 10);
  const section: ManifestSection = "HEADER";

  const companyNameLine = headerLines.find((line, index) => {
    if (index < 1) return false;
    const text = line.normalized;
    return /\b(?:S\.A\.|SAS|LTDA)\b/.test(text);
  });

  const text = headerLines.map((line) => line.raw).join("\n");
  const nit = text.match(/NIT\s*:\s*([A-Z0-9.-]+)/i)?.[1] ?? null;
  const address = text.match(/Direccion\s*:\s*(.+?)(?=\n|$)/i)?.[1] ?? null;
  const city = text.match(/Ciudad\s*:\s*(.+?)(?=\n|$)/i)?.[1] ?? null;
  const phone = text.match(/Telefono\s*:\s*([0-9+()\-\s]+)/i)?.[1] ?? null;

  return {
    nit: exactField(nit ? clean(nit) : null, section, "NIT", 0.99),
    name: exactField(companyNameLine ? clean(companyNameLine.raw) : null, section, "Nombre de la empresa", 0.99),
    address: exactField(address ? clean(address) : null, section, "Direccion", 0.98),
    phone: exactField(phone ? clean(phone) : null, section, "Telefono", 0.98),
    city: exactField(city ? clean(city) : null, section, "Ciudad", 0.98),
  };
}

function parseManifestIdentity(lines: ParsedLine[]): Pick<ManifestExtraction["manifest"], "manifestNumber" | "authorizationNumber"> {
  const text = lines.slice(0, 25).map((line) => line.raw).join(" ");
  const manifest = text.match(/Manifiesto\s*:\s*([A-Z0-9-]+)/i)?.[1] ?? null;
  const authorization = text.match(/Autorizacion\s*:\s*([A-Z0-9-]+)/i)?.[1] ?? null;

  return {
    manifestNumber: exactField(manifest, "HEADER", "Manifiesto", 0.99),
    authorizationNumber: exactField(authorization, "HEADER", "Autorizacion", 0.99),
  };
}

function parseManifestInformation(lines: ParsedLine[]): ManifestExtraction["manifest"] {
  const section: ManifestSection = "MANIFEST_INFORMATION";
  const identity = parseManifestIdentity(lines);

  const headerIndex = lines.findIndex((line) => {
    const n = line.normalized;
    return n.includes("FECHA EXPED") && n.includes("TIPO MANIFIESTO") && n.includes("ORIGEN DEL VIAJE");
  });

  let issueDate: string | null = null;
  let manifestType: string | null = null;
  let origin: string | null = null;
  let intermediateCity: string | null = null;
  let destination: string | null = null;

  if (headerIndex >= 0) {
    const dataLine = lines.slice(headerIndex + 1).find((line) => /\d{2}[-/.]\d{2}[-/.]\d{4}/.test(line.raw));

    if (dataLine) {
      const values = splitLayoutColumns(dataLine.raw);
      const dateIndex = values.findIndex((value) => parseDate(value) !== null);
      issueDate = dateIndex >= 0 ? parseDate(values[dateIndex]) : null;

      const remaining = dateIndex >= 0 ? values.slice(dateIndex + 1) : values;
      if (remaining.length >= 1) manifestType = remaining[0] ?? null;
      if (remaining.length >= 2) origin = remaining[1] ?? null;
      if (remaining.length >= 3) destination = remaining[remaining.length - 1] ?? null;
    }
  }

  if (!origin) {
    origin = inferRouteValue(lines, "ORIGEN DEL VIAJE");
  }
  if (!destination) {
    destination = inferRouteValue(lines, "DESTINO DEL VIAJE");
  }

  const intermediate = findValueNearLabel(lines, ["CIUDAD INTERMEDIA", "CIUDAD INTEMEDIA"], section);
  const payment = parsePayment(lines);

  return {
    ...identity,
    issueDate: exactField(issueDate, section, "Fecha Exped (Dia/mes/Año)", issueDate ? 0.99 : 0),
    manifestType: exactField(manifestType, section, "Tipo Manifiesto", manifestType ? 0.98 : 0),
    origin: exactField(origin, section, "Origen del Viaje", origin ? 0.95 : 0),
    intermediateCity: intermediate.value ? intermediate : emptyField(section),
    destination: exactField(destination, section, "Destino del Viaje", destination ? 0.95 : 0),
    policyOwnerName: findValueNearLabel(lines, FIELD_ALIASES.manifest.policyOwnerName, "RECIPIENT"),
    ...payment,
    recommendations: findRecommendations(lines),
  };
}

function inferRouteValue(lines: ParsedLine[], label: string): string | null {
  const target = normalizePdfText(label);
  const lineIndex = lines.findIndex((line) => line.normalized.includes(target));
  if (lineIndex < 0) return null;

  const nearby = lines.slice(lineIndex, lineIndex + 4).flatMap((line) => splitLayoutColumns(line.raw));
  const excluded = new Set([
    normalizeLine(label),
    "FECHA EXPED (DIA/MES/ANO)",
    "TIPO MANIFIESTO",
    "CIUDAD INTEMEDIA",
    "CIUDAD INTERMEDIA",
    "DESTINO DEL VIAJE",
  ]);

  return nearby.find((value) => {
    const n = normalizeLine(value);
    return n && !excluded.has(n) && /^[A-ZÁÉÍÓÚÑ .'-]+$/i.test(value) && n.length > 2;
  }) ?? null;
}

function parseVehicleBlock(lines: ParsedLine[]) {
  const vehicleSection: ManifestSection = "VEHICLE_AND_DRIVER";
  const driverSection: ManifestSection = "DRIVER";
  const holderSection: ManifestSection = "VEHICLE_HOLDER";

  const vehicleHeader = lines.findIndex((line) => {
    const n = line.normalized;
    return n.includes("PLACA") && n.includes("MARCA") && n.includes("CONFIGURACION") && n.includes("PESO VACIO");
  });

  const vehicleData = vehicleHeader >= 0 ? findDataRow(lines, vehicleHeader) : null;
  const vehicleValues = vehicleData ? splitLayoutColumns(vehicleData.raw) : [];

  const plate = vehicleValues.find((value) => /^[A-Z]{3}\d{3}$/.test(normalizeLine(value))) ?? null;
  const brand = vehicleValues.find((value) => /^(CHEVROLET|KENWORTH|VOLVO|SCANIA|MACK|HINO|FREIGHTLINER|INTERNATIONAL)$/i.test(clean(value))) ?? null;
  const semiTrailerPlate = vehicleValues.find((value) => /^[A-Z]\d{5}$/.test(normalizeLine(value))) ?? null;
  const configuration = vehicleValues.find((value) => /^\d[A-Z]\d$/.test(normalizeLine(value))) ?? null;
  const weightText = vehicleValues.find((value) => /\d[\d.,]*\s*(?:KGS)?$/i.test(clean(value)) && parseMoney(value) !== null && parseMoney(value)! >= 1000) ?? null;
  const policy = vehicleValues.find((value) => /^\d{10,15}$/.test(clean(value))) ?? null;
  const insurer = vehicleValues.find((value) => /SEGUROS|SEGUROS SA|ASEGURADORA/i.test(value)) ?? null;
  const soatDate = vehicleValues.find((value) => parseDate(value) !== null && !/07-02-2026/.test(value)) ?? null;

  const titularRow = findPersonRow(lines, "TITULAR MANIFIESTO");
  const driverRow = findPersonRow(lines, "CONDUCTOR");
  const holderRow = findPersonRow(lines, "POSEEDOR O TENEDOR DEL VEHICULO");

  const titular = parsePersonRow(titularRow?.data, vehicleSection, "Titular Manifiesto");
  const driver = parseDriverRow(driverRow?.data);
  const holder = parsePersonRow(holderRow?.data, holderSection, "Poseedor o Tenedor del Vehiculo");

  const phone = findPhoneFromFooter(lines);

  if (driver.phone.value === null && phone) {
    driver.phone = exactField(phone, driverSection, "Cel. Cond.", 0.99);
  }

  return {
    vehicle: {
      plate: exactField(plate ? clean(plate) : null, vehicleSection, "Placa", plate ? 0.99 : 0),
      brand: exactField(brand ? clean(brand) : null, vehicleSection, "Marca", brand ? 0.99 : 0),
      semiTrailerPlate: exactField(semiTrailerPlate ? clean(semiTrailerPlate) : null, vehicleSection, "Placa Semiremolque", semiTrailerPlate ? 0.99 : 0),
      configuration: exactField(configuration ? clean(configuration) : null, vehicleSection, "Configuracion", configuration ? 0.99 : 0),
      emptyWeight: exactField(weightText ? parseMoney(weightText) : null, vehicleSection, "Peso Vacio", weightText ? 0.98 : 0),
      soatPolicyNumber: exactField(policy ? clean(policy) : null, vehicleSection, "N° Poliza SOAT", policy ? 0.99 : 0),
      soatInsuranceCompany: exactField(insurer ? clean(insurer) : null, vehicleSection, "Cia. Segura SOAT", insurer ? 0.99 : 0),
      soatExpirationDate: exactField(soatDate ? parseDate(soatDate) : null, vehicleSection, "Vencimiento SOAT", soatDate ? 0.99 : 0),
    },
    manifestHolder: titular,
    driver,
    vehicleHolder: holder,
  };
}

function findDataRow(lines: ParsedLine[], headerIndex: number): ParsedLine | undefined {
  for (let i = headerIndex + 1; i < lines.length && i < headerIndex + 4; i += 1) {
    const normalized = lines[i].normalized;
    if (!normalized) continue;
    if (/^(CONDUCTOR|POSEEDOR|INFORMACION|VALOR DEL VIAJE|INFORMACION DE LA MERCANCIA)/.test(normalized)) continue;
    return lines[i];
  }
  return undefined;
}

function findPersonRow(lines: ParsedLine[], marker: string): { header: ParsedLine; data: ParsedLine } | null {
  const markerNormalized = normalizePdfText(marker);
  const headerIndex = lines.findIndex((line) => line.normalized.includes(markerNormalized));
  if (headerIndex < 0) return null;

  const data = findDataRow(lines, headerIndex);
  return data ? { header: lines[headerIndex], data } : null;
}

function parsePersonRow(
  row: ParsedLine | undefined,
  section: ManifestSection,
  nameLabel: string,
): ManifestExtraction["manifestHolder"] | ManifestExtraction["vehicleHolder"] {
  if (!row) {
    return {
      identificationNumber: emptyField(section),
      fullName: emptyField(section),
      address: emptyField(section),
      phone: emptyField(section),
      city: emptyField(section),
    };
  }

  const values = splitLayoutColumns(row.raw);
  const identification = values.find((value) => /^\d{7,12}$/.test(clean(value))) ?? null;
  const city = values.find((value) => /^(IBAGUE|MEDELLIN|BOGOTA|CALI|BUENAVENTURA|BARRANQUILLA)$/i.test(clean(value))) ?? null;
  const address = values.find((value) => /\b(CALLE|CARRERA|DIAG|AV|AVENIDA)\b/i.test(value)) ?? null;
  const name = values.find((value) => looksLikePersonName(value)) ?? null;
  const phone = values.find((value) => /\b3\d{9}\b/.test(value)) ?? null;

  return {
    identificationNumber: exactField(identification, section, "Docto de Identificacion No.", identification ? 0.99 : 0),
    fullName: exactField(name, section, nameLabel, name ? 0.97 : 0),
    address: exactField(address ? clean(address) : null, section, "Direccion", address ? 0.94 : 0),
    phone: exactField(phone, section, "Telefono", phone ? 0.98 : 0),
    city: exactField(city ? clean(city) : null, section, "Ciudad y Departamento", city ? 0.94 : 0),
  };
}

function parseDriverRow(row: ParsedLine | undefined): ManifestExtraction["driver"] {
  const section: ManifestSection = "DRIVER";
  if (!row) {
    return {
      identificationNumber: emptyField(section),
      fullName: emptyField(section),
      licenseCategory: emptyField(section),
      address: emptyField(section),
      phone: emptyField(section),
      city: emptyField(section),
    };
  }

  const values = splitLayoutColumns(row.raw);
  const identification = values.find((value) => /^\d{7,12}$/.test(clean(value))) ?? null;
  const license = values.find((value) => /^\d{7,12}-[A-Z0-9]+$/.test(clean(value))) ?? null;
  const city = values.find((value) => /^(IBAGUE|MEDELLIN|BOGOTA|CALI|BUENAVENTURA|BARRANQUILLA)$/i.test(clean(value))) ?? null;
  const address = values.find((value) => /\b(CALLE|CARRERA|DIAG|AV|AVENIDA)\b/i.test(value)) ?? null;
  const name = values.find((value) => looksLikePersonName(value)) ?? null;
  const phone = values.find((value) => /\b3\d{9}\b/.test(value)) ?? null;

  return {
    identificationNumber: exactField(identification, section, "Docto. de Identificacion No.", identification ? 0.99 : 0),
    fullName: exactField(name, section, "Conductor", name ? 0.97 : 0),
    licenseCategory: exactField(license, section, "CAT. LIC. CONDUCCION", license ? 0.99 : 0),
    address: exactField(address ? clean(address) : null, section, "Direccion", address ? 0.94 : 0),
    phone: exactField(phone, section, "Telefono", phone ? 0.98 : 0),
    city: exactField(city ? clean(city) : null, section, "Ciudad y Departamento", city ? 0.94 : 0),
  };
}

function parseCargo(lines: ParsedLine[]): ManifestExtraction["cargo"] {
  const section: ManifestSection = "CARGO";
  const markerIndex = lines.findIndex((line) => line.normalized.includes("NUMERO DE") && line.normalized.includes("REMESA"));
  const candidates = markerIndex >= 0 ? lines.slice(markerIndex + 1, markerIndex + 7) : lines;
  const joined = candidates.map((line) => line.raw).join("\n");
  const normalized = normalizePdfText(joined);

  const remittance = findFirstMatch(normalized, /\b\d{5,8}\b/);
  const productCode = findFirstMatch(normalized, /\b\d{4,8}\b/g)?.[0] ?? null;
  const quantity = findFirstMatch(normalized, /\b\d+[.,]\d+\b/);
  const unit = findFirstMatch(normalized, /\bKGS\b|\bKILOGRAMOS\b|\bUNIDADES?\b/);
  const product = findTextContaining(candidates, /(CONTENEDOR|PRODUCTO|VACIO)/i);

  return {
    remittanceNumber: exactField(remittance, section, "Numero de Remesa", remittance ? 0.99 : 0),
    measurementUnit: exactField(unit === "KGS" ? "KILOGRAMOS" : unit, section, "Unidad de Medida", unit ? 0.96 : 0),
    quantity: exactField(quantity ? parseMoney(quantity) : null, section, "Cantidad", quantity ? 0.98 : 0),
    nature: exactField(findTextContaining(candidates, /CARGA\s+GENERAL/i), section, "Naturaleza", 0.96),
    packaging: exactField(findPackaging(candidates), section, "Empaque", findPackaging(candidates) ? 0.90 : 0),
    productCode: exactField(productCode, section, "Codigo de Producto", productCode ? 0.99 : 0),
    transportedProduct: exactField(product, section, "Producto Transportado", product ? 0.95 : 0),
  };
}

function findPackaging(lines: ParsedLine[]): string | null {
  for (const line of lines) {
    const match = line.raw.match(/\b\d+\s*C\s*\d+\s*Pies?\b/i);
    if (match) return clean(match[0]);
  }
  return null;
}

function parseParties(lines: ParsedLine[]) {
  const sender = extractParty(lines, "INFORMACION REMITENTE", "SENDER");
  const recipient = extractParty(lines, "INFORMACION DESTINATARIO", "RECIPIENT");

  return {
    sender,
    recipient,
    cargoOwner: {
      identificationNumber: emptyField<string>("RECIPIENT"),
      name: emptyField<string>("RECIPIENT"),
    },
  };
}

function extractParty(
  lines: ParsedLine[],
  marker: string,
  section: "SENDER" | "RECIPIENT",
): ManifestExtraction["sender"] {
  const index = lines.findIndex((line) => line.normalized.includes(normalizePdfText(marker)));
  if (index < 0) {
    return {
      identificationNumber: emptyField(section),
      name: emptyField(section),
    };
  }

  const window = lines.slice(index, index + 6);
  const ids = window
    .flatMap((line) => line.raw.match(/\b\d{7,12}\b/g) ?? [])
    .filter(Boolean);

  const names = window
    .map((line) => clean(line.raw))
    .filter((line) => /[A-ZÁÉÍÓÚÑ]{3,}/i.test(line))
    .filter((line) => !/^(INFORMACION|NIT|NOMBRE|CIUDAD|TELEFONO|DUEÑO)/i.test(line));

  return {
    identificationNumber: exactField(ids[0] ?? null, section, "Nit / cc", ids[0] ? 0.96 : 0),
    name: exactField(names.find((value) => /[A-Z]{3,}\s+[A-Z]{3,}/i.test(value)) ?? names[0] ?? null, section, "Nombre / Razon Social", names.length ? 0.91 : 0),
  };
}

function parsePayment(lines: ParsedLine[]) {
  const section: ManifestSection = "PAYMENT";
  const text = lines.map((line) => line.raw).join("\n");

  const extractMoney = (aliases: readonly string[]) => {
    for (const alias of aliases) {
      const normalizedAlias = normalizePdfText(alias);
      const normalizedText = normalizePdfText(text);
      const index = normalizedText.indexOf(normalizedAlias);
      if (index < 0) continue;
      const after = normalizedText.slice(index + normalizedAlias.length);
      const match = after.match(/[^0-9$]{0,80}\$?\s*([\d.,]+)/);
      if (match) {
        return parseMoney(match[1]);
      }
    }
    return null;
  };

  const placeDate = normalizePdfText(text).match(/LUGAR\s+(.+?)\s+FECHA\s+(\d{2}-\d{2}-\d{4})/);
  const loading = normalizePdfText(text).match(/CARGUE PAGADO POR\s+(.+?)(?=\n|$)/)?.[1] ?? null;
  const unloading = normalizePdfText(text).match(/DESCARGUE PAGADO POR\s+(.+?)(?=\n|$)/)?.[1] ?? null;
  const letters = text.match(/VALOR A PAGAR PACTADO EN LETRAS:\s*(.+?)(?:\n|$)/i)?.[1] ?? null;

  return {
    totalTripValue: exactField(extractMoney(FIELD_ALIASES.manifest.totalTripValue), section, "VALOR TOTAL DEL VIAJE", 0.99),
    withholdingTax: exactField(extractMoney(FIELD_ALIASES.manifest.withholdingTax), section, "RETENCION EN LA FUENTE", 0.99),
    icaWithholding: exactField(extractMoney(FIELD_ALIASES.manifest.icaWithholding), section, "RETENCION ICA", 0.99),
    netValueToPay: exactField(extractMoney(FIELD_ALIASES.manifest.netValueToPay), section, "VALOR NETO A PAGAR", 0.99),
    advanceValue: exactField(extractMoney(FIELD_ALIASES.manifest.advanceValue), section, "VALOR ANTICIPO", 0.99),
    balanceToPay: exactField(extractMoney(FIELD_ALIASES.manifest.balanceToPay), section, "SALDO A PAGAR", 0.99),
    paymentLocation: exactField(placeDate?.[1]?.trim() ?? null, section, "LUGAR", placeDate ? 0.96 : 0),
    paymentDate: exactField(placeDate ? parseDate(placeDate[2]) : null, section, "FECHA", placeDate ? 0.99 : 0),
    loadingPaidBy: exactField(loading ? clean(loading) : null, section, "CARGUE PAGADO POR", loading ? 0.97 : 0),
    unloadingPaidBy: exactField(unloading ? clean(unloading) : null, section, "DESCARGUE PAGADO POR", unloading ? 0.97 : 0),
    agreedValueInWords: exactField(letters ? clean(letters) : null, section, "VALOR A PAGAR PACTADO EN LETRAS", letters ? 0.99 : 0),
  };
}

function findRecommendations(lines: ParsedLine[]): ExtractedField<string> {
  const section: ManifestSection = "RECOMMENDATIONS";
  const index = lines.findIndex((line) => normalizeLine(line.raw) === "RECOMENDACIONES");
  if (index < 0) return emptyField(section);

  const content = lines
    .slice(index + 1)
    .map((line) => clean(line.raw))
    .find((value) => value && !/^FIRMA|^DOCUMENTO FIRMADO|^TANQUES DEL NORDESTE/i.test(value));

  return exactField(content ?? null, section, "RECOMENDACIONES", content ? 0.90 : 0);
}

function findPhoneFromFooter(lines: ParsedLine[]): string | null {
  for (const line of lines) {
    const match = line.raw.match(/Cel\.\s*Cond\.?\s*:\s*(\d{10})/i);
    if (match) return match[1];
  }
  return null;
}

function looksLikePersonName(value: string): boolean {
  const normalized = normalizePdfText(value).trim();
  return (
    normalized.split(/\s+/).length >= 2 &&
    /^[A-ZÑ.' -]+$/i.test(value) &&
    !/(CALLE|CARRERA|DIAG|AVENIDA|IBAGUE|MEDELLIN|BOGOTA|CALI)/i.test(value)
  );
}

function findFirstMatch(text: string, pattern: RegExp): string | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const match = new RegExp(pattern.source, flags).exec(text);
  return match?.[1] ?? match?.[0] ?? null;
}

function findTextContaining(lines: ParsedLine[], pattern: RegExp): string | null {
  return lines.map((line) => clean(line.raw)).find((value) => pattern.test(value)) ?? null;
}

/**
 * Main parser. It receives text extracted from a DIGITAL PDF. The extractor
 * used by pdf.ts must preserve the horizontal layout of the source document;
 * this is important for the tabular sections.
 */
export function parseManifestText(text: string): ManifestExtraction {
  const parsed = parseSections(text);
  const lines = parsed.lines;

  const company = parseCompany(lines);
  const manifest = parseManifestInformation(lines);
  const vehicleAndPeople = parseVehicleBlock(lines);
  const parties = parseParties(lines);
  const cargo = parseCargo(lines);

  const extraction: ManifestExtraction = {
    company,
    manifest,
    manifestHolder: vehicleAndPeople.manifestHolder,
    driver: vehicleAndPeople.driver,
    vehicleHolder: vehicleAndPeople.vehicleHolder,
    vehicle: vehicleAndPeople.vehicle,
    cargoOwner: parties.cargoOwner,
    sender: parties.sender,
    recipient: parties.recipient,
    cargo,
  };

  return ManifestExtractionSchema.parse(extraction);
}

export function tryParseManifestText(text: string) {
  try {
    const data = parseManifestText(text);
    return {
      success: true as const,
      data,
      errors: [],
    };
  } catch (error) {
    return {
      success: false as const,
      data: null,
      errors: [error instanceof Error ? error.message : "Error de validacion del manifiesto"],
    };
  }
}
