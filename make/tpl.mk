# Usage:
#   $(call tpl-include, TEMPLATE, PLACEHOLDER, INCLUDEFILE, OUTPUT)

define compose
	@awk '\
	BEGIN { \
		while ((getline < "$(2)") > 0) { \
			if ($$0 == "") continue ; \
			split($$0, parts, ":") ; \
			map[parts[1]] = parts[2] ; \
		} ; \
		close("$(2)") ; \
	} \
	{ \
		found = 0 ; \
		for (placeholder in map) { \
			if ($$0 ~ placeholder) { \
				match($$0, /^[[:space:]]*/) ; \
				indent = substr($$0, RSTART, RLENGTH) ; \
				while ((getline line < map[placeholder]) > 0) { \
					print indent line ; \
				} ; \
				close(map[placeholder]) ; \
				found = 1 ; \
				break ; \
			} ; \
		} ; \
		if (!found) print ; \
	} \
	' '$(1)' > '$(3)'
endef