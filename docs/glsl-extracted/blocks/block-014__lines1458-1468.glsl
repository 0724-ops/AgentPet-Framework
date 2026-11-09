// lines 1458..1468   char-offsets 379182..379441
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,UD=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
