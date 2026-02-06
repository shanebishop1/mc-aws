# Security Hardening Report - 2026-02-05

## Overview

This report summarizes security hardening work completed on the mc-aws project to address high-severity vulnerabilities and strengthen authentication and authorization controls.

## Changes Implemented

### 1. OAuth State Hardening (/api/gdrive/setup & /api/gdrive/callback)

**Problem**: Original OAuth flow had insufficient CSRF protection and mock mode override capabilities.

**Changes**:
- **Enhanced State Management**: Implemented cryptographically secure OAuth state generation using `arctic` library
- **Secure Cookie Storage**: OAuth state now stored in HTTP-only, secure cookies with 10-minute expiry
- **State Validation**: Added comprehensive state validation in callback endpoint with cookie matching
- **Mock Mode Security**: Removed `?mock=true` override capability - mock mode now only available when `isMockMode()` returns true
- **Error Handling**: Added detailed error responses for state validation failures

**Security Benefits**:
- Prevents CSRF attacks on OAuth flow
- Eliminates unauthorized mock mode activation
- Proper session state cleanup prevents token leakage

### 2. IAM Policy Tightening (CDK Stack)

**Problem**: Overly permissive IAM policies and potential privilege escalation vectors.

**Changes**:
- **KMS Decryption Scope**: Limited KMS decrypt permissions to specific encryption context for `/minecraft/*` SSM parameters
- **EC2 Self-Stop Restriction**: Added CloudFormation stack tag condition to prevent unauthorized instance stopping
- **Resource-Specific Permissions**: Scoped Lambda permissions to specific instance IDs where possible
- **Parameter Access Control**: Limited SSM access to specific parameter paths

**Security Benefits**:
- Reduces blast radius of compromised credentials
- Prevents cross-parameter data access
- Implements least privilege principles

### 3. Dependency Security Updates

**Package Updates**:
- **AWS SDK**: Updated from 3.547.0 to 3.984.0 for multiple Lambda functions
- **Fast XML Parser**: Override applied to enforce version ≥5.3.4 (XEE vulnerability fix)
- **ISAACS Brace Expansion**: Override applied to enforce version ≥5.0.1 (ReDoS vulnerability fix)

**Lambda Function Updates**:
- `StartMinecraftServer`: Updated all AWS SDK dependencies
- `SeedEmailAllowlist`: Updated SSM client dependency
- Added package-lock.json files for dependency pinning

**Security Benefits**:
- Eliminates known high-severity vulnerabilities
- Prevents dependency confusion attacks
- Ensures consistent dependency resolution

## Verification Results

### Unit Tests Added
- **OAuth State Tests**: Comprehensive test suite for `/api/gdrive/setup` covering state generation, cookie handling, and mock mode security
- **OAuth Callback Tests**: Full test suite for `/api/gdrive/callback` covering state validation, error handling, and authentication
- **Mock Mode Security Tests**: Verify mock mode cannot be overridden via URL parameters
- **Error Handling Tests**: Validate proper error responses and cleanup

### Test Coverage
- State generation and storage: ✅
- State validation and CSRF prevention: ✅
- Mock mode restrictions: ✅
- Admin authentication requirements: ✅
- Cookie cleanup on errors/success: ✅
- Error message sanitization: ✅

### Security Testing
- CSRF protection verified through state validation tests
- Mock mode override prevention confirmed
- Authentication bypass attempts blocked
- Proper error handling prevents information leakage

## Residual Issues & Exceptions

### Non-High Priority Items
1. **SSH Access**: SSH port remains accessible but requires IAM role-based access via SSM Session Manager
2. **Email Parameter Scoping**: SES permissions remain wildcarded due to AWS API limitations (standard pattern)
3. **DescribeInstances Wildcard**: EC2 DescribeInstances requires wildcard resource (AWS API limitation)

### Acceptable Risk Items
- Current SSH approach uses AWS SSM Session Manager as primary access method
- SES wildcard permissions follow AWS documentation patterns
- EC2 DescribeInstances wildcard is an AWS API requirement

## Files Modified

### OAuth Security
- `app/api/gdrive/setup/route.ts` - Enhanced state generation and mock mode security
- `app/api/gdrive/callback/route.ts` - Added comprehensive state validation
- `app/api/gdrive/setup/route.test.ts` - New comprehensive test suite
- `app/api/gdrive/callback/route.test.ts` - New comprehensive test suite

### Infrastructure Security
- `infra/lib/minecraft-stack.ts` - IAM policy tightening and resource scoping

### Dependency Security
- `package.json` - Dependency updates and security overrides
- `pnpm-lock.yaml` - Updated dependency lock file
- `infra/src/lambda/StartMinecraftServer/package.json` - AWS SDK updates
- `infra/src/lambda/StartMinecraftServer/package-lock.json` - New lock file
- `infra/src/lambda/SeedEmailAllowlist/package.json` - AWS SDK updates
- `infra/src/lambda/SeedEmailAllowlist/package-lock.json` - New lock file

## Security Improvements Summary

| Category | Before | After | Impact |
|----------|--------|-------|---------|
| CSRF Protection | ❌ Basic state | ✅ Cryptographic state + validation | High |
| Mock Mode Security | ❌ URL override | ✅ Environment-controlled only | High |
| IAM Permissions | ❌ Overly permissive | ✅ Scoped & conditioned | Medium |
| Dependencies | ❌ Known vulns | ✅ All high vulns patched | High |
| Authentication | ✅ Existing | ✅ Enhanced validation | Low |

## Recommendations

1. **Regular Security Scans**: Implement automated dependency scanning in CI/CD
2. **IAM Monitoring**: Add CloudTrail logging for sensitive operations
3. **Periodic Review**: Schedule quarterly IAM policy reviews
4. **Access Auditing**: Implement SSM access logging and alerts

## Conclusion

The security hardening successfully addressed all high-priority vulnerabilities while maintaining system functionality. The OAuth flow now has robust CSRF protection, IAM policies follow least privilege principles, and dependency vulnerabilities are resolved. Residual risks are acceptable and follow AWS best practices.

**Security Posture**: Significantly improved from baseline vulnerability exposure to enterprise-grade security controls.