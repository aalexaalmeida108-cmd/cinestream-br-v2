// Streaming Site - Main Application
// Platform: Browser (Vanilla JS)
// Data source: EmbedMovies catalog (https://embedmovies.org)

const API_BASE = 'https://embedmovies.org';
const PLAYER_BASE = 'https://myembed.biz';

// State
let currentCategory = 'filmes';
let current_page = 1;
let searchQuery = '';
let catalogCache = {
  filmes: [],
  series: [],
  animes: []
};

// DOM Elements
const contentGrid = document.getElementById('contentGrid');
const messageEl = document.getElementById('message');
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const filterButtons = document.querySelectorAll('.filter-btn');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initFilters();
  initSearch();
  loadCategory('filmes');
});

// Initialize filter buttons
function initFilters() {
  filterButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const category = e.target.dataset.category;
      setActiveFilter(category);
      loadCategory(category);
    });
  });
}

// Set active filter state
function setActiveFilter(category) {
  filterButtons.forEach(btn => {
    if (btn.dataset.category === category) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// Initialize search
function initSearch() {
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    searchQuery = searchInput.value.trim();
    performSearch();
  });
}

// Load category content
async function loadCategory(category, reset = true) {
  currentCategory = category;

  if (reset) {
    current_page = 1;
    catalogCache[category] = [];
  }

  // Check cache first
  if (catalogCache[category].length > 0 && reset) {
    renderContent(catalogCache[category]);
    return;
  }

  showLoading();

  try {
    const data = await fetchCatalog(category, current_page);

    if (data && data.items) {
      catalogCache[category] = [...catalogCache[category], ...data.items];

      if (reset) {
        renderContent(data.items);
      } else {
        // Append for infinite scroll
        data.items.forEach(item => {
          const card = createCard(item);
          contentGrid.appendChild(card);
        });
      }
    } else {
      showMessage('Nenhum conteúdo encontrado', 'empty');
    }
  } catch (error) {
    console.error('Error loading category:', error);
    showMessage('Erro ao carregar conteúdo. Tente novamente.', 'error');
  }
}

// Fetch catalog from EmbedMovies
async function fetchCatalog(category, page) {
  const url = `${API_BASE}/${category}?page=${page}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return parseCatalogHTML(html, category);
  } catch (error) {
    console.error('Fetch error:', error);
    throw error;
  }
}

// Parse catalog HTML and extract items
function parseCatalogHTML(html, category) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const items = [];
  const cards = doc.querySelectorAll('.content-grid .card, .movie-card, .film-card');

  for (const card of cards) {
    const titleEl = card.querySelector('.card-title, .title, h3');
    const imageEl = card.querySelector('img');
    const linkEl = card.querySelector('a');

    if (titleEl && (imageEl || linkEl)) {
      // Try to extract TMDB/IMDb ID from URL or data attributes
      let tmdbId = null;
      let imdbId = null;

      if (linkEl) {
        const href = linkEl.href;
        // Check for TMDB ID in URL: /filme/tmdb-123456 or /filme/123456
        const tmdbMatch = href.match(/tmdb-(\d+)/i);
        if (tmdbMatch) {
          tmdbId = tmdbMatch[1];
        } else {
          // Try to get ID from query params or path
          const idMatch = href.match(/(\d+)$/);
          if (idMatch) {
            tmdbId = idMatch[1];
          }
        }

        // Check for IMDb ID
        const imdbMatch = href.match(/tt\d+/);
        if (imdbMatch) {
          imdbId = imdbMatch[0];
        }
      }

      // Get poster URL
      let posterUrl = '';
      if (imageEl) {
        posterUrl = imageEl.src || imageEl.dataset.src || '';
      }

      // Extract year if present
      let year = null;
      const yearEl = card.querySelector('.year, .year-badge, .meta-year');
      if (yearEl) {
        year = yearEl.textContent.trim();
      }

      // Determine type
      let type = category === 'series' ? 'serie' : (category === 'animes' ? 'anime' : 'filme');

      // Try to detect from card classes
      const classes = card.className;
      if (classes.includes('serie')) type = 'serie';
      else if (classes.includes('anime')) type = 'anime';

      items.push({
        title: titleEl.textContent.trim(),
        poster: posterUrl,
        tmdbId: tmdbId,
        imdbId: imdbId,
        year: year,
        type: type,
        category: category,
        url: linkEl ? linkEl.href : null
      });
    }
  }

  // Fallback: try to find any movie items if specific selectors failed
  if (items.length === 0) {
    // Generic fallback - look for any list items with movie-like structure
    const allLinks = doc.querySelectorAll('a');
    for (const link of allLinks) {
      const href = link.href;
      if (href && (href.includes('/filme') || href.includes('/serie') || href.includes('/anime'))) {
        // Try to find title
        const title = link.textContent.trim();
        if (title && !title.includes('»') && !title.includes('«')) {
          const tmdbMatch = href.match(/tmdb-(\d+)/i);
          items.push({
            title: title,
            poster: '',
            tmdbId: tmdbMatch ? tmdbMatch[1] : null,
            imdbId: null,
            year: null,
            type: category === 'series' ? 'serie' : (category === 'animes' ? 'anime' : 'filme'),
            category: category,
            url: href
          });
        }
      }
    }
  }

  return {
    items: items,
    hasNextPage: items.length > 0 // Will be refined with actual pagination detection
  };
}

// Create card element
function createCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.tmdbId = item.tmdbId || '';
  card.dataset.imdbId = item.imdbId || '';
  card.dataset.type = item.type;
  card.dataset.category = item.category;

  // Determine poster URL - use placeholder if needed
  const posterUrl = item.poster || getPlaceholderPoster(item.type);

  // Create poster image
  const img = document.createElement('img');
  img.className = 'card-image';
  img.src = posterUrl;
  img.alt = item.title;
  img.loading = 'lazy';

  // Create content div
  const content = document.createElement('div');
  content.className = 'card-content';

  // Title
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = item.title;

  // Meta info
  const meta = document.createElement('div');
  meta.className = 'card-meta';

  // Category badge
  const badge = document.createElement('span');
  badge.className = `category-badge ${item.type}`;
  badge.textContent = item.type;

  // Year
  const yearSpan = document.createElement('span');
  yearSpan.textContent = item.year || '----';

  meta.appendChild(badge);
  meta.appendChild(yearSpan);

  content.appendChild(title);
  content.appendChild(meta);

  card.appendChild(img);
  card.appendChild(content);

  // Add click handler
  card.addEventListener('click', () => {
    openPlayer(item);
  });

  return card;
}

// Get placeholder poster
function getPlaceholderPoster(type) {
  const colors = {
    filme: '3b82f6',
    serie: '10b981',
    anime: 'f97316'
  };
  const color = colors[type] || '3b82f6';
  return `https://placehold.co/400x600/${color}/ffffff?text=${encodeURIComponent(type)}`;
}

// Open player for item
function openPlayer(item) {
  if (!item.tmdbId && !item.imdbId) {
    showMessage('ID do conteúdo não disponível', 'error');
    return;
  }

  let playerUrl;
  if (item.type === 'serie') {
    // For series, open a generic player - user will select season/episode
    playerUrl = `${PLAYER_BASE}/serie/${item.tmdbId || item.imdbId}/1/1?autoplay=1`;
  } else {
    // Movie
    playerUrl = `${PLAYER_BASE}/filme/${item.tmdbId || item.imdbId}?autoplay=1`;
  }

  // Navigate to player page
  window.location.href = `player.html?url=${encodeURIComponent(playerUrl)}&title=${encodeURIComponent(item.title)}&type=${item.type}`;
}

// Perform search
async function performSearch() {
  if (!searchQuery) {
    loadCategory(currentCategory);
    return;
  }

  showLoading();

  try {
    const results = await searchCatalog(searchQuery);
    renderContent(results);
  } catch (error) {
    console.error('Search error:', error);
    showMessage('Erro na busca. Tente novamente.', 'error');
  }
}

// Search catalog
async function searchCatalog(query) {
  // Try the search endpoint if available
  const url = `${API_BASE}/pesquisa?q=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const results = parseSearchHTML(html);

    return results;
  } catch (error) {
    console.error('Search fetch error:', error);
    // Return empty if search fails
    return [];
  }
}

// Parse search results HTML
function parseSearchHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const items = [];
  const cards = doc.querySelectorAll('.content-grid .card, .movie-card, .search-result');

  for (const card of cards) {
    const titleEl = card.querySelector('.card-title, .title, h3, .result-title');
    const imageEl = card.querySelector('img');
    const linkEl = card.querySelector('a');

    if (titleEl && (imageEl || linkEl)) {
      let tmdbId = null;
      let imdbId = null;

      if (linkEl) {
        const href = linkEl.href;
        const tmdbMatch = href.match(/tmdb-(\d+)/i);
        if (tmdbMatch) {
          tmdbId = tmdbMatch[1];
        }
        const imdbMatch = href.match(/tt\d+/);
        if (imdbMatch) {
          imdbId = imdbMatch[0];
        }
      }

      let posterUrl = '';
      if (imageEl) {
        posterUrl = imageEl.src || imageEl.dataset.src || '';
      }

      // Detect type
      let type = 'filme';
      const classes = card.className.toLowerCase();
      if (classes.includes('serie')) type = 'serie';
      else if (classes.includes('anime')) type = 'anime';

      items.push({
        title: titleEl.textContent.trim(),
        poster: posterUrl,
        tmdbId: tmdbId,
        imdbId: imdbId,
        type: type,
        category: type + 's',
        url: linkEl ? linkEl.href : null
      });
    }
  }

  return items;
}

// Render content grid
function renderContent(items) {
  contentGrid.innerHTML = '';

  if (items.length === 0) {
    showMessage('Nenhum resultado encontrado', 'empty');
    return;
  }

  items.forEach(item => {
    const card = createCard(item);
    contentGrid.appendChild(card);
  });
}

// Show loading state
function showLoading() {
  contentGrid.innerHTML = '';
  messageEl.innerHTML = '';

  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.innerHTML = '<div class="spinner"></div>';
  contentGrid.appendChild(loading);

  messageEl.style.display = 'none';
}

// Show message
function showMessage(text, type = '') {
  contentGrid.innerHTML = '';
  messageEl.innerHTML = text;
  messageEl.className = `message ${type}`;
  messageEl.style.display = 'block';
}

// Get player URL for item
function getPlayerUrl(item) {
  if (!item.tmdbId && !item.imdbId) {
    return null;
  }

  const id = item.tmdbId || item.imdbId;

  if (item.type === 'serie') {
    return `${PLAYER_BASE}/serie/${id}`;
  }

  return `${PLAYER_BASE}/filme/${id}`;
}

// Export for potential module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    loadCategory,
    searchCatalog,
    getPlayerUrl
  };
}
