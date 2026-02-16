# Mise Integration Setup

## Summary

This document describes the mise (version manager) integration that was set up for the mc-aws project.

## Changes Made

### 1. Created `mise.toml` (Project Root)

A modern mise configuration file was created with the following content:

```toml
[tools]
node = "22"
pnpm = "10"

[env]
# Add node_modules/.bin to PATH for local tooling
_.path = ["{{config_root}}/node_modules/.bin"]
```

**Features:**
- Defines Node.js version 22 and pnpm version 10
- Automatically adds `node_modules/.bin` to PATH for local tooling
- Uses modern TOML format (preferred over `.tool-versions`)

### 2. Updated `setup.sh` (Lines 255-332)

The mise setup logic was completely rewritten to be intelligent and idempotent:

#### Key Improvements:

**a) Automatic Installation:**
- Checks if mise is already in PATH
- If not in PATH but installed at `~/.local/bin/mise`, adds it to PATH for the current session
- If not installed at all, automatically installs using `curl https://mise.run | sh`
- Default installation location: `~/.local/bin/mise`

**b) Shell Configuration:**
- Checks `~/.zshrc` for existing mise configuration
- Adds `export PATH="$HOME/.local/bin:$PATH"` if not present
- Adds `eval "$(~/.local/bin/mise activate zsh)"` if not present
- Prevents duplicate entries (idempotent)
- Notifies user to restart terminal or run `source ~/.zshrc` if changes were made

**c) Automatic Activation:**
- Once mise is activated in zshrc, it automatically activates when entering any directory with a `mise.toml` or `.tool-versions` file
- No manual activation needed per directory

**d) Tool Installation:**
- Runs `mise install` to ensure Node.js 22 and pnpm 10 are available
- Provides clear feedback about what's happening

**e) User-Friendly Messages:**
- Clear success/info/error messages with emojis
- Explains what mise will do automatically
- Warns user when shell configuration is updated

### 3. Kept `.tool-versions` for Backward Compatibility

The existing `.tool-versions` file was kept unchanged:

```
node 22
pnpm 10
```

This ensures compatibility with asdf users. mise can read both `.tool-versions` and `mise.toml` files.

## How It Works

### First-Time Setup (No mise installed):

1. User runs `./setup.sh`
2. Script detects mise is not installed
3. Installs mise using `curl https://mise.run | sh`
4. Adds mise to `~/.zshrc` (PATH and activation)
5. Runs `mise install` to install Node.js 22 and pnpm 10
6. Continues with rest of setup

### Subsequent Runs (mise already installed):

1. User runs `./setup.sh`
2. Script detects mise is in PATH
3. Skips installation and shell configuration
4. Runs `mise install` to ensure tools are up-to-date
5. Continues with rest of setup

### Automatic Activation:

Once mise is configured in `~/.zshrc`:

1. User opens new terminal (or runs `source ~/.zshrc`)
2. User `cd`s into the mc-aws directory
3. mise automatically activates Node.js 22 and pnpm 10
4. User can run `node`, `pnpm`, etc. with correct versions

## Testing

The setup was tested with:

1. **Bash syntax validation:** `bash -n setup.sh` passed
2. **mise config validation:** `mise ls` successfully parsed `mise.toml`
3. **Tool detection:** `mise which node` and `mise which pnpm` found the correct versions
4. **Logic verification:** Test script confirmed all branches of the setup logic work correctly

## Idempotency

The setup is fully idempotent:

- Running `./setup.sh` multiple times is safe
- Won't reinstall mise if already installed
- Won't duplicate entries in `~/.zshrc`
- Won't fail if configuration already exists

## Files Modified/Created

1. **Created:** `/Users/shane/projects/mc-aws/mise.toml` (7 lines)
2. **Modified:** `/Users/shane/projects/mc-aws/setup.sh` (lines 255-332, ~78 lines)
3. **Kept:** `/Users/shane/projects/mc-aws/.tool-versions` (unchanged, for asdf compatibility)

## Benefits

1. **Automatic version management:** No manual Node.js or pnpm version switching
2. **Project-specific versions:** Each project can have its own versions
3. **Shell integration:** Automatic activation when entering project directory
4. **Backward compatible:** Works with asdf's `.tool-versions` format
5. **User-friendly:** Clear messages and automatic setup
6. **Idempotent:** Safe to run multiple times

## Troubleshooting

If mise doesn't activate automatically:

1. Ensure `~/.zshrc` contains:
   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   eval "$(~/.local/bin/mise activate zsh)"
   ```

2. Restart your terminal or run:
   ```bash
   source ~/.zshrc
   ```

3. Verify mise is working:
   ```bash
   mise --version
   mise ls
   ```

4. Check if tools are installed:
   ```bash
   mise which node
   mise which pnpm
   ```

## References

- mise documentation: https://mise.jdx.dev/
- mise activation: https://mise.jdx.dev/cli/activate.html
- mise config: https://mise.jdx.dev/configuration.html