# Palitra Push JSON compatibility

Code-only packet for one existing backend module. Handles absent optional expirationTime while preserving strict endpoint, encryption-key and authorization checks. Covers existing client runtimes.

The guarded release reads an exact accepted parent, verifies all source/static hashes and an exclusive operator lock, backs up the original module, and performs one content-only update. Staging alone does not install or enable subscriptions. Physical-device delivery requires separate acceptance.
