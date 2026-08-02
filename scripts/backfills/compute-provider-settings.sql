UPDATE workspace_sandbox_settings
SET
  provider = 'daytona',
  provider_config_json = json_object(
    'kind', 'daytona',
    'apiKeySecretName', daytona_api_key_secret_name,
    'apiUrl', daytona_api_url,
    'target', daytona_target,
    'profiles', json_object(
      'small', json(CASE
        WHEN NULLIF(COALESCE(small_snapshot, snapshot), '') IS NOT NULL
          THEN json_object('kind', 'snapshot', 'value', COALESCE(small_snapshot, snapshot))
        WHEN NULLIF(image, '') IS NOT NULL
          THEN json_object('kind', 'image', 'value', image)
        ELSE 'null'
      END),
      'medium', json(CASE
        WHEN NULLIF(COALESCE(medium_snapshot, snapshot), '') IS NOT NULL
          THEN json_object('kind', 'snapshot', 'value', COALESCE(medium_snapshot, snapshot))
        WHEN NULLIF(image, '') IS NOT NULL
          THEN json_object('kind', 'image', 'value', image)
        ELSE 'null'
      END)
    )
  ),
  default_resource_profile = 'small'
WHERE provider_config_json IS NULL;
