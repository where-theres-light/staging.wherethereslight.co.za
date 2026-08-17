include make/tpl.mk

# Two builds, differing only in whether the back-end (online) calls are kept:
#   make dev  — offline/staging build; strips Supabase/PayFast calls, seeds demo
#   make prd  — production build; keeps online calls, writes the live CNAME
# Both compose the pages through make/web.map into ui/dist (generated, ignored).

SRC  := ui
DIST := ui/dist
MAP  := make/web.map

.PHONY: dev stg prd stage clean c

# ---- dev: offline/staging build (back-end calls stripped) ----
dev: stage
	@sed -i '/\/\/online-start$$/,/\/\/online-end$$/d' $(DIST)/shared.js
	@sed -i '/\/\/online$$/d' $(DIST)/shared.js
	@cp $(SRC)/demo.js $(DIST)/
	@sed -i 's#<script src="shared.js"></script>#<script src="demo.js"></script>\n<script src="shared.js"></script>#' $(DIST)/*.html
	@echo "Built dev (offline) → $(DIST)"

# ---- stg: online build for the staging site (back-end calls kept, no demo) ----
# Same online code as prd; the staging CNAME is written by the Pages workflow.
# PayFast runs in sandbox for the staging origin (chosen by the edge function).
stg: stage
	@echo "Built stg (online) → $(DIST)"

# ---- prd: production build (back-end calls kept) ----
prd: stage
	@echo "wherethereslight.co.za" > $(DIST)/CNAME
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
