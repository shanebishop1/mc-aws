export function isValidEmail(email: string): boolean {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex !== email.lastIndexOf("@") || /\s/u.test(email)) return false;

  const dotIndex = email.indexOf(".", atIndex + 2);
  return dotIndex !== -1 && dotIndex < email.length - 1;
}
