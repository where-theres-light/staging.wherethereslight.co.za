include make/tpl.mk

# Two builds, differing only in whether the back-end (online) calls are kept:
#   make dev  — offline/staging build; strips Supabase/PayFast calls, seeds demo
#   make prd  — production build; keeps online calls, writes the live CNAME
# Both compose the pages through make/web.map into ui/dist (generated, ignored).

SRC  := ui
DIST := ui/dist
MAP  := make/web.map

# Production base URL + the indexable pages listed in sitemap.xml (prd only).
# Deliberately omits the dynamic product template and the transactional
# success/cancel pages — none is a standalone URL worth indexing.
BASE          := https://wherethereslight.co.za
SITEMAP_PAGES := index townscapes amelias-house gift-tags upcoming subscribe

.PHONY: dev stg prd stage clean c

# ---- dev: offline/staging build (back-end calls stripped) ----
dev: stage
	@sed -i '/\/\/online-start$$/,/\/\/online-end$$/d' $(DIST)/shared.js
	@sed -i '/\/\/online$$/d' $(DIST)/shared.js
	@cp $(SRC)/demo.js $(DIST)/
	@sed -i 's#<script src="shared.js"></script>#<script src="demo.js"></script>\n<script src="shared.js"></script>#' $(DIST)/*.html
	@cp $(SRC)/robots.staging.txt $(DIST)/robots.txt
	@echo "Built dev (offline) → $(DIST)"

# ---- stg: online build for the staging site (back-end calls kept, no demo) ----
# Same online code as prd; the staging CNAME is written by the Pages workflow.
# PayFast runs in sandbox for the staging origin (chosen by the edge function).
stg: stage
	@cp $(SRC)/robots.staging.txt $(DIST)/robots.txt
	@echo "Built stg (online) → $(DIST)"

# ---- prd: production build (back-end calls kept) ----
prd: stage
	@echo "wherethereslight.co.za" > $(DIST)/CNAME
	@cp $(SRC)/robots.prd.txt $(DIST)/robots.txt
	@{ \
	  echo '<?xml version="1.0" encoding="UTF-8"?>'; \
	  echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'; \
	  for n in $(SITEMAP_PAGES); do \
	    if [ "$$n" = index ]; then loc="$(BASE)/"; else loc="$(BASE)/$$n.html"; fi; \
	    mod=$$(git log -1 --format=%cs -- $(SRC)/$$n.html 2>/dev/null); \
	    [ -n "$$mod" ] || mod=$$(date -u +%Y-%m-%d); \
	    echo "  <url><loc>$$loc</loc><lastmod>$$mod</lastmod></url>"; \
	  done; \
	  echo '</urlset>'; \
	} > $(DIST)/sitemap.xml
	@echo "Built prd → $(DIST)"

# ---- stage: compose pages + copy static files into a fresh dist ----
stage: clean
	@mkdir -p $(DIST)
	$(call compose,$(SRC)/index.html,$(MAP),$(DIST)/index.html)
	$(call compose,$(SRC)/product.html,$(MAP),$(DIST)/product.html)
	$(call compose,$(SRC)/amelias-house.html,$(MAP),$(DIST)/amelias-house.html)
	$(call compose,$(SRC)/gift-tags.html,$(MAP),$(DIST)/gift-tags.html)
	$(call compose,$(SRC)/townscapes.html,$(MAP),$(DIST)/townscapes.html)
	$(call compose,$(SRC)/upcoming.html,$(MAP),$(DIST)/upcoming.html)
	$(call compose,$(SRC)/subscribe.html,$(MAP),$(DIST)/subscribe.html)
	$(call compose,$(SRC)/success.html,$(MAP),$(DIST)/success.html)
	$(call compose,$(SRC)/cancel.html,$(MAP),$(DIST)/cancel.html)
	@cp $(SRC)/styles.css $(SRC)/shared.js $(DIST)/
	@cp -r $(SRC)/assets $(DIST)/assets

# ---- clean: remove the build output ----
clean c:
	@rm -rf $(DIST)
