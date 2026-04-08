export function formatCurrency(value?: number | null, currency: string = "GBP") {
  if (value === null || value === undefined) {
    return "Value not disclosed";
  }
  
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency || "GBP",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatDate(dateString?: string | null) {
  if (!dateString) return "Unknown";
  
  return new Date(dateString).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}
