export function isNumeric(str: unknown) {
    return /^-?\d+$/.test(String(str));
}
