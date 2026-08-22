TYPE_CHECK = npm run typecheck
TEST       = npm test
TEST_ALL   = npm run test:all
TEST_INST  = npm run test:install
AUDIT      = npm audit --audit-level=high
CLEAN      = rm -rf node_modules *.tsbuildinfo

.PHONY: all typecheck test test-all test-install audit clean

all: typecheck test

typecheck:
	$(TYPE_CHECK)

test:
	$(TEST)

test-all: typecheck test test-install

test-install:
	$(TEST_INST)

audit:
	$(AUDIT)

clean:
	$(CLEAN)