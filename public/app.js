// Login page logic
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const loginBtn = document.getElementById('loginBtn');
    const errorMessage = document.getElementById('errorMessage');
    const successMessage = document.getElementById('successMessage');

    // Role selection
    const roleBtns = document.querySelectorAll('.role-btn');
    const roleInput = document.getElementById('role');
    const signupLink = document.getElementById('signupLink');

    roleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Update UI
            roleBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update value
            roleInput.value = btn.dataset.role;

            // Show/hide admin secret code field
            const adminCodeGroup = document.getElementById('adminCodeGroup');
            if (adminCodeGroup) {
                adminCodeGroup.style.display = btn.dataset.role === 'admin' ? 'block' : 'none';
                adminCodeGroup.style.animation = btn.dataset.role === 'admin' ? 'slideUp 0.3s ease-out' : 'none';
            }

            // Update signup link text and href
            if (signupLink) {
                const roleLabel = btn.dataset.role.charAt(0).toUpperCase() + btn.dataset.role.slice(1);
                signupLink.textContent = `Create an Account as ${roleLabel}`;
                signupLink.href = `/signup.html?role=${btn.dataset.role}`;
            }
        });
    });

    // Initialize signup link based on default role
    if (signupLink) {
        const initialRole = roleInput.value || (document.querySelector('.role-btn.active') || {}).dataset?.role || 'student';
        const roleLabel = initialRole.charAt(0).toUpperCase() + initialRole.slice(1);
        signupLink.textContent = `Create an Account as ${roleLabel}`;
        signupLink.href = `/signup.html?role=${initialRole}`;
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const selectedRole = roleInput.value;
        const adminCode = (document.getElementById('adminCode') || {}).value || '';

        // Validation
        if (!username || !password) {
            showError('Please enter both username and password');
            return;
        }
        if (selectedRole === 'admin' && !adminCode) {
            showError('Admin secret code is required');
            return;
        }

        // Disable button
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<span>Logging in...</span>';

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password, role: selectedRole, adminCode })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                // Store token and user details - always trust server role
                sessionStorage.setItem('username', username);
                sessionStorage.setItem('token', data.token);
                sessionStorage.setItem('role', data.role);

                showSuccess('Login successful! Redirecting...');

                // Redirect based on server-assigned role
                if (data.role === 'admin') {
                    setTimeout(() => window.location.href = '/admin.html', 500);
                } else {
                    setTimeout(() => window.location.href = '/dashboard.html', 500);
                }
            } else {
                showError(data.error || 'Login failed');
                // Reset button
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<span>Login</span>';
            }
        } catch (error) {
            console.error('Login error:', error);
            showError('Connection error. Please try again.');
            loginBtn.disabled = false;
            loginBtn.innerHTML = '<span>Login</span>';
        }
    });

    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
        successMessage.style.display = 'none';

        setTimeout(() => {
            errorMessage.style.display = 'none';
        }, 5000);
    }

    function showSuccess(message) {
        successMessage.textContent = message;
        successMessage.style.display = 'block';
        errorMessage.style.display = 'none';
    }
});
