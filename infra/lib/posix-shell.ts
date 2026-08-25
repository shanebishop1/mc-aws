/** Quote one value as a single POSIX shell word. */
export const quotePosixShellArgument = (value: string): string => `'${value.split("'").join(`'"'"'`)}'`;
