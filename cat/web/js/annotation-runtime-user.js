// Extracted from annotation-file-mode-runtime.js (Phase 2b: user helpers)
    // Fetch current logged-in user and auto-fill analyst field
    async function fetchCurrentUser() {
      // Restore analyst from localStorage if not already populated
      const analystField = document.getElementById('analyst');
      if (analystField && !analystField.value) {
        const saved = localStorage.getItem('cat_analyst');
        if (saved) {
          analystField.value = saved;
          markFieldAsAutofilled(analystField);
          console.log('✅ Restored analyst from localStorage:', saved);
        }
      }
      // Persist analyst name to localStorage whenever it changes
      if (analystField) {
        analystField.addEventListener('change', () => {
          if (analystField.value.trim()) {
            localStorage.setItem('cat_analyst', analystField.value.trim().toUpperCase());
          }
        });
        analystField.addEventListener('blur', () => {
          if (analystField.value.trim()) {
            localStorage.setItem('cat_analyst', analystField.value.trim().toUpperCase());
          }
        });
      }
      return;
      
      /* Removed database authentication code
      try {
        const response = await fetch(`${serverUrl}/api/auth/me`);
        if (response.ok) {
          const user = await response.json();
          if (user && user.username) {
            // Update navbar to show logged-in user
            const userBadge = document.getElementById('currentUserBadge');
            const usernameSpan = document.getElementById('currentUsername');
            const logoutBtn = document.getElementById('logoutBtn');
            
            if (userBadge && usernameSpan) {
              usernameSpan.textContent = user.username;
              userBadge.style.display = 'inline-block';
            }
            
            if (logoutBtn) {
              logoutBtn.style.display = 'inline';
            }
            
            // Auto-fill the analyst field with username
            const analystField = document.getElementById('analyst');
            if (analystField && !analystField.value) {
              // Use first 10 characters of username (or create initials)
              let analystValue = user.username;
              
              // If username is too long, try to create initials
              if (analystValue.length > 10) {
                // Try to create initials from username (e.g., "john.doe" -> "JD")
                const parts = analystValue.split(/[._-]/);
                if (parts.length > 1) {
                  analystValue = parts.map(p => p[0].toUpperCase()).join('');
                } else {
                  // Just truncate to 10 chars
                  analystValue = analystValue.substring(0, 10);
                }
              }
              
              analystField.value = analystValue.toUpperCase();
              markFieldAsAutofilled(analystField);
              console.log('✅ Auto-filled analyst field with:', analystValue);
            }
            
            // Set username for timer and load cumulative stats
            timerState.username = user.username;
            loadTotalTime();
          }
        } else if (response.status === 401) {
          console.log('⚠️ User not logged in - analyst field not auto-filled');
        }
      } catch (error) {
        console.warn('Could not fetch current user:', error);
        // Non-fatal error - user can still manually enter analyst name
      }
      */
    }
    
    // Logout function
    async function logout() {
      try {
        const response = await fetch(`${serverUrl}/api/auth/logout`, {
          method: 'POST',
          credentials: 'include'
        });
        
        if (response.ok) {
          // Redirect to auth page
          window.location.href = '/auth';
        }
      } catch (error) {
        console.error('Logout error:', error);
        // Still redirect even if there's an error
        window.location.href = '/auth';
      }
      return false; // Prevent default link behavior
    }
    
