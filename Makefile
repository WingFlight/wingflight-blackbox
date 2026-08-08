# ========================================
# VARIABLES
# ========================================

.DELETE_ON_ERROR:
.ONESHELL:
.SHELLFLAGS       := -eu -c
.DEFAULT_GOAL     := help

SEMVER            ?= 0.0.0

# ========================================
# RULES
# ========================================

.PHONY: init
init: ## Install development dependencies
	pnpm install --frozen-lockfile

.PHONY: version
version: ## Set application version to $SEMVER
	sed -i -e 's/\("version":[ \t]*\)".*"/\1"$(SEMVER)"/' package.json

.PHONY: apps
apps: ## Build NW.js desktop apps for all platforms
	pnpm gulp apps

.PHONY: debug
debug: ## Run debug build and launch it (NW.js desktop)
	pnpm gulp debug

.PHONY: release
release: ## Build installers for all platforms (NW.js desktop)
	pnpm gulp release

.PHONY: dev-server
dev-server: ## Run development server (Vite -- serves the app with reload-on-save)
	pnpm vite

.PHONY: web
web: dev-server ## Alias for dev-server

.PHONY: dev-client
dev-client: ## Launch the real NW.js desktop shell pointed at dev-server (start dev-server first)
	pnpm gulp dev-client

.PHONY: all
all: apps

.PHONY: clean
clean: ## Remove apps/debug/release/dev-client build output
	rm -fr apps debug release dev-client

.PHONY: realclean
realclean: clean ## Also remove the intermediate dist/ copy
	rm -fr dist

.PHONY: distclean
distclean: realclean ## Also remove the cached NW.js runtime and node_modules
	rm -fr cache node_modules

# ========================================
# HELP
# ========================================

blue      := $(shell tput setaf 4)
grey500   := $(shell tput setaf 244)
grey300   := $(shell tput setaf 240)
bold      := $(shell tput bold)
underline := $(shell tput smul)
reset     := $(shell tput sgr0)

.PHONY: help
help: ## Display this help
	@printf '\n'
	@printf '  $(underline)$(grey500)Targets$(reset)\n\n'
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*?##/ \
		{ printf "  $(grey300)make$(reset) $(bold)$(blue)%-20s$(reset) $(grey500)%s$(reset)\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@printf '\n'
