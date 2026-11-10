/** Keep the form's UTF-16 length limit without cutting a supplementary character in half. */
export function limitFeedbackText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return text.slice(0, end);
}
