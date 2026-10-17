# Vendor resources

Thunder SDK binaries are staged from the Windows build machine's existing installation into `vendor/thunder/sdk` when building the Windows installer. The packaged application verifies the SDK hashes and uses only the bundled copy. The source installation is read-only and is not modified.
