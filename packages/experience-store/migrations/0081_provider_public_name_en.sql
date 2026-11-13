BEGIN;

-- #587: the provider's public name in English. A person registered in Japanese shows in kanji on the English site
-- (`public_display_name`); this optional column is what the English pages, emails and metadata show instead. Empty (null)
-- means the Japanese name is shown as before. The Japanese site never reads it. Same rules as the name it stands for.
ALTER TABLE experience_provider_public_profiles
  ADD COLUMN public_display_name_en text CHECK (
    public_display_name_en IS NULL OR (
      char_length(public_display_name_en) BETWEEN 1 AND 300
      AND public_display_name_en !~ '^\s|\s$'
      AND public_display_name_en !~ '[[:cntrl:]]'
    )
  );

COMMIT;
