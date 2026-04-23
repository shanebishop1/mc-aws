# Mise Integration Setup

## Summary

This document describes the mise (version manager) integration that was set up for the mc-aws project.

## Changes Made

### 1. Created `mise.toml` (Project Root)

A modern mise configuration file was created with the following content:

```toml
[tools]
node = "22.15.1"
pnpm = "10.30.3"

[env]
# Add node_modules/.bin to PATH for local tooling
_.path = ["{{config_root}}/node_modules/.bin"]
```

**Features:**
- Defines exact Node.js and pnpm versions used locally and in CI
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
- Does not edit shell startup files automatically
- Prints optional activation commands for zsh, bash, and fish
- Keeps setup behavior portable across shells and machines

**c) Automatic Activation:**
- `setup.sh` uses `mise exec` so the pinned toolchain works immediately for the setup run
- Users can still enable automatic activation manually in their preferred shell later

**d) Tool Installation:**
- Runs `mise install` to ensure Node.js 22.15.1 and pnpm 10.30.3 are available
- Provides clear feedback about what's happening

**e) User-Friendly Messages:**
- Clear success/info/error messages with emojis
- Explains the pinned versions being used
- Prints an optional shell-activation hint instead of mutating dotfiles

### 3. Kept `.tool-versions` for Backward Compatibility

The existing `.tool-versions` file was kept unchanged:

```
node 22.15.1
pnpm 10.30.3
```

This ensures compatibility with asdf users. mise can read both `.tool-versions` and `mise.toml` files.

## How It Works

### First-Time Setup (No mise installed):

1. User runs `./setup.sh`
2. Script detects mise is not installed
3. Installs mise using `curl https://mise.run | sh`
4. Runs `mise install` to install Node.js 22.15.1 and pnpm 10.30.3
5. Uses `mise exec` for the rest of setup
6. Continues with rest of setup

### Subsequent Runs (mise already installed):

1. User runs `./setup.sh`
2. Script detects mise is in PATH
3. Skips installation
4. Runs `mise install` to ensure tools are up-to-date
5. Continues with rest of setup

### Optional Future-Shell Activation:

If the user wants automatic activation outside `setup.sh`, they can add the appropriate `mise activate` command to their shell config.

## Testing

The setup was tested with:

1. **Bash syntax validation:** `bash -n setup.sh` passed
2. **mise config validation:** `mise ls` successfully parsed `mise.toml`
3. **Tool detection:** `mise which node` and `mise which pnpm` found the correct versions
4. **Doctor verification:** `pnpm repo:doctor -- --toolchain-only` verifies the pinned versions and required files

## Idempotency

The setup is fully idempotent:

- Running `./setup.sh` multiple times is safe
- Won't reinstall mise if already installed
- Won't fail if configuration already exists

## Files Modified/Created

1. **Created:** `/Users/shane/projects/mc-aws/mise.toml` (7 lines)
2. **Modified:** `/Users/shane/projects/mc-aws/setup.sh` (lines 255-332, ~78 lines)
3. **Kept:** `/Users/shane/projects/mc-aws/.tool-versions` (unchanged, for asdf compatibility)

## Benefits

1. **Automatic version management:** No manual Node.js or pnpm version switching
2. **Project-specific versions:** Each project can have its own versions
3. **Shell agnostic:** Setup works in bash, zsh, and fish without mutating dotfiles
4. **Backward compatible:** Works with asdf's `.tool-versions` format
5. **User-friendly:** Clear messages and automatic setup
6. **Idempotent:** Safe to run multiple times

## Troubleshooting

If mise doesn't activate automatically:

1. Verify mise is working:
   ```bash
   mise --version
   mise ls
   ```

2. Check if tools are installed:
   ```bash
   mise which node
   mise which pnpm
   ```

3. If you want future shells to auto-activate the toolchain, add the matching `mise activate` command for your shell (`zsh`, `bash`, or `fish`).

## References

- mise documentation: https://mise.jdx.dev/
- mise activation: https://mise.jdx.dev/cli/activate.html
- mise config: https://mise.jdx.dev/configuration.html
